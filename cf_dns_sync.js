// cron "*/5 * * * *" cf_dns_sync.js, tag:Cloudflare DNS自动同步
function Env(name) { this.name = name; }
const $ = new Env('Cloudflare DNS自动同步');
/**
 * Cloudflare 域名优选 IP 自动故障转移与解析同步脚本 (Node.js 版)
 *
 * 本地存储协作版改动：
 * - 支持从同目录 `config.txt` 自动加载环境变量（缺失时补齐）
 * - CF_IP_POOL 支持“本地文件路径”（相对/绝对），用于直接读取 cfst_test.js 落盘的优选 IP 列表
 * - 若 CF_IP_POOL 为空，默认读取 `./data/cfst_preferred_ips.txt`
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ================================
// 兼容青龙/本地配置自动加载变量
// ================================

const CONFIG_TXT_PATH = path.join(__dirname, 'config.txt');

function loadEnvFromConfigTxtIfNeeded(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('export ')) trimmed = trimmed.slice('export '.length).trim();
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function parseConfigShToEnv(data) {
  const lines = data.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('export ')) continue;

    // export KEY="VALUE"
    let m = trimmed.match(/^export\s+(\w+)="([^"]*)"$/);
    if (m) {
      const key = m[1];
      const value = m[2];
      if (!process.env[key]) process.env[key] = value;
      continue;
    }

    // export KEY='VALUE'
    m = trimmed.match(/^export\s+(\w+)='([^']*)'$/);
    if (m) {
      const key = m[1];
      const value = m[2];
      if (!process.env[key]) process.env[key] = value;
      continue;
    }

    // export KEY=VALUE
    m = trimmed.match(/^export\s+(\w+)=(.+)$/);
    if (m) {
      const key = m[1];
      const raw = (m[2] || '').trim();
      if (!process.env[key]) process.env[key] = raw;
    }
  }
}

function loadEnvFromQingLongConfigIfNeeded() {
  const candidates = [
    '/ql/data/config/config.json',
    '/ql/config/config.json',
    '/ql/data/config/config.sh'
  ];
  for (const fp of candidates) {
    if (!fs.existsSync(fp)) continue;
    try {
      const raw = fs.readFileSync(fp, 'utf8');
      if (fp.endsWith('.json')) {
        const json = JSON.parse(raw);
        if (json && typeof json === 'object') {
          for (const [k, v] of Object.entries(json)) {
            if (v === undefined || v === null) continue;
            const str = String(v);
            if (!process.env[k]) process.env[k] = str;
          }
        }
      } else {
        parseConfigShToEnv(raw);
      }
      console.log(`已加载青龙配置文件: ${fp}`);
      return;
    } catch (e) {
      console.warn(`无法加载青龙配置 ${fp}: ${e.message}`);
    }
  }
}

// 优先级：青龙环境变量(天然优先) > 青龙配置 -> 再用本目录 config.txt 补齐默认值
loadEnvFromQingLongConfigIfNeeded();
loadEnvFromConfigTxtIfNeeded(CONFIG_TXT_PATH);

function resolveDataDir() {
  const envDir = process.env.LOCAL_DATA_DIR;
  const resolved = envDir
    ? path.isAbsolute(envDir) ? envDir : path.resolve(__dirname, envDir)
    : path.join(__dirname, 'data');
  try { fs.mkdirSync(resolved, { recursive: true }); } catch (e) { }
  return resolved;
}

const DATA_DIR = resolveDataDir();
const DEFAULT_POOL_FILE = path.join(DATA_DIR, 'cfst_preferred_ips.txt');

// --- 配置区域 (优先从环境变量读取) ---
function normalizeIpUpdateMode(rawMode) {
  return rawMode === 'latency' ? 'latency' : 'fallback';
}

function parseRuntimeConfig(env) {
  return {
    CF_API_TOKEN: env.CF_API_TOKEN,
    CF_ZONE_ID: env.CF_ZONE_ID,
    CF_DOMAIN: env.CF_DOMAIN,
    CF_IP_POOL: env.CF_IP_POOL || '',
    MAX_IPS: parseInt(env.MAX_IPS, 10) || 2,
    NOTIFY_THRESHOLD: parseInt(env.NOTIFY_THRESHOLD, 10) || 2,
    POOL_SAMPLE_COUNT: parseInt(env.POOL_SAMPLE_COUNT, 10) || 0,
    IP_UPDATE_MODE: normalizeIpUpdateMode(env.IP_UPDATE_MODE),
  };
}

function buildFallbackTargetIps(healthyCurrentEntries, healthyPoolEntries, maxIps) {
  const retainedIps = healthyCurrentEntries.slice(0, maxIps).map(entry => entry.ip);
  if (retainedIps.length >= maxIps) return retainedIps;

  const gapSize = maxIps - retainedIps.length;
  const supplementaryIps = healthyPoolEntries.slice(0, gapSize).map(entry => entry.ip);
  return [...retainedIps, ...supplementaryIps];
}

function buildLatencyCandidateIps(currentIps, poolIps) {
  return Array.from(new Set([...currentIps, ...poolIps]));
}

function pickTopHealthyIps(results, maxIps) {
  return results
    .filter(result => result.success)
    .sort((a, b) => a.latency - b.latency)
    .slice(0, maxIps)
    .map(result => result.ip);
}

function loadRuntimeConfig() {
  return parseRuntimeConfig(process.env);
}

const TEST_TIMEOUT = 2000;

function findFileUpwards(filename, startDir) {
  let currentDir = startDir || __dirname;
  const root = path.parse(currentDir).root;
  while (currentDir !== root) {
    const filePath = path.join(currentDir, filename);
    if (fs.existsSync(filePath)) return filePath;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  return null;
}

async function sendNotification(title, content) {
  console.log(`\n[通知] ${title}: ${content}`);
  try {
    const notifyPath = findFileUpwards('sendNotify.js');
    if (notifyPath) {
      const notify = require(notifyPath);
      if (notify && typeof notify.sendNotify === 'function') {
        await notify.sendNotify(title, content);
      }
    }
  } catch (e) {
    console.error(`[通知失败] ${e.message}`);
  }
}

function fetchIpsFromUrl(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { timeout: 10000 }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        console.warn(`  ⚠️ 获取 ${url} 失败，HTTP ${res.statusCode}`);
        resolve([]);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const ipRegex = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
        const ips = data.match(ipRegex) || [];
        console.log(`  ✅ 从 ${url} 获取到 ${ips.length} 个 IP`);
        resolve(ips);
      });
    }).on('error', (e) => {
      console.warn(`  ⚠️ 获取 ${url} 出错: ${e.message}`);
      resolve([]);
    });
  });
}

function readIpsFromLocalFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const data = fs.readFileSync(filePath, 'utf8');
    const ipRegex = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
    const ips = data.match(ipRegex) || [];
    console.log(`  ✅ 从本地文件 ${filePath} 读取到 ${ips.length} 个 IP`);
    return ips;
  } catch (e) {
    console.warn(`  ⚠️ 读取本地文件失败 ${filePath}: ${e.message}`);
    return [];
  }
}

function isProbablyLocalPath(item) {
  if (!item) return false;
  if (item.startsWith('http://') || item.startsWith('https://')) return false;
  // 允许相对路径/绝对路径；也允许 file://
  if (item.startsWith('file://')) return true;
  if (item.startsWith('./') || item.startsWith('../') || item.startsWith('/') || item.includes(path.sep)) return true;
  // 纯文件名但存在于同目录/data 里也算
  return fs.existsSync(path.resolve(__dirname, item));
}

function resolvePoolFilePath(item) {
  if (item.startsWith('file://')) return item.slice('file://'.length);
  return path.isAbsolute(item) ? item : path.resolve(__dirname, item);
}

async function parseIpPool(poolStr) {
  const str = (poolStr && poolStr.trim()) ? poolStr.trim() : DEFAULT_POOL_FILE;
  const items = str.split(',').map(s => s.trim()).filter(Boolean);

  const directIps = [];
  const urlItems = [];
  const fileItems = [];

  for (const item of items) {
    if (item.startsWith('http://') || item.startsWith('https://')) {
      urlItems.push(item);
      continue;
    }
    if (isProbablyLocalPath(item)) {
      fileItems.push(resolvePoolFilePath(item));
      continue;
    }

    const ip = item.split(':')[0];
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
      directIps.push(ip);
    } else {
      console.warn(`  ⚠️ 跳过无效条目: ${item}`);
    }
  }

  console.log(`📋 直接 IP: ${directIps.length} 个, 远程 URL: ${urlItems.length} 个, 本地文件: ${fileItems.length} 个`);

  const remoteResults = await Promise.all(urlItems.map(url => fetchIpsFromUrl(url)));
  const remoteIps = remoteResults.flat();
  const localIps = fileItems.flatMap(fp => readIpsFromLocalFile(fp));

  return Array.from(new Set([...directIps, ...remoteIps, ...localIps]));
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function testIp(ip) {
  return new Promise((resolve) => {
    const start = Date.now();
    const options = {
      hostname: ip,
      port: 443,
      path: '/cdn-cgi/trace',
      method: 'GET',
      headers: { 'Host': 'cloudflare.com' },
      timeout: TEST_TIMEOUT,
      rejectUnauthorized: false
    };

    const req = https.get(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        const latency = Date.now() - start;
        if (res.statusCode === 200 && body.includes('fl=')) resolve({ ip, latency, success: true });
        else resolve({ ip, success: false });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ip, success: false, reason: 'timeout' });
    });

    req.on('error', (e) => {
      resolve({ ip, success: false, reason: e.message });
    });
  });
}

async function cfApiRequest(method, apiPath, data = null) {
  return new Promise((resolve, reject) => {
    const { CF_API_TOKEN } = loadRuntimeConfig();
    const options = {
      hostname: 'api.cloudflare.com',
      port: 443,
      path: `/client/v4${apiPath}`,
      method: method,
      headers: {
        'Authorization': `Bearer ${CF_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.success) resolve(json.result);
          else reject(new Error(JSON.stringify(json.errors)));
        } catch (e) {
          reject(new Error(`解析响应失败: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

function sortHealthyEntries(results) {
  return results
    .filter(result => result.success)
    .sort((a, b) => a.latency - b.latency);
}

async function main() {
  const {
    CF_API_TOKEN,
    CF_ZONE_ID,
    CF_DOMAIN,
    CF_IP_POOL,
    MAX_IPS,
    NOTIFY_THRESHOLD,
    POOL_SAMPLE_COUNT,
    IP_UPDATE_MODE,
  } = loadRuntimeConfig();
  console.log(`\n🚀 开始执行 Cloudflare DNS 自动同步（本地池支持版）...`);
  console.log(`数据目录: ${DATA_DIR}`);
  console.log(`目标域名: ${CF_DOMAIN}`);

  if (!CF_API_TOKEN || !CF_ZONE_ID || !CF_DOMAIN) {
    console.error('❌ 错误: 缺少必要环境变量 (CF_API_TOKEN, CF_ZONE_ID, CF_DOMAIN)');
    process.exit(1);
  }

  console.log('\n☁️ 正在获取当前 DNS 解析记录...');
  let currentRecords;
  try {
    currentRecords = await cfApiRequest('GET', `/zones/${CF_ZONE_ID}/dns_records?name=${CF_DOMAIN}&type=A`);
  } catch (e) {
    console.error(`❌ 获取记录失败: ${e.message}`);
    return;
  }

  const currentIps = currentRecords.map(r => r.content);
  console.log(`当前在岗 IP: [${currentIps.join(', ') || '无'}]`);
  console.log(`更新模式: ${IP_UPDATE_MODE}`);

  let finalHealthyIps = [];

  if (IP_UPDATE_MODE === 'latency') {
    console.log('\n⚖️ latency 模式：统一比较当前 DNS 与候选池的探测延迟...');
    const poolIps = await parseIpPool(CF_IP_POOL);
    const candidateIps = buildLatencyCandidateIps(currentIps, poolIps);

    console.log(`🔍 待测试候选 IP 数量: ${candidateIps.length}`);
    const latencyResults = candidateIps.length > 0
      ? await Promise.all(candidateIps.map(ip => testIp(ip)))
      : [];

    finalHealthyIps = pickTopHealthyIps(latencyResults, MAX_IPS);
    console.log(`📊 latency 优选结果: ${finalHealthyIps.length} 个健康 IP 入选`);
  } else {
    let healthyInPlaceEntries = [];
    if (currentIps.length > 0) {
      console.log(`⏳ 正在对当前 ${currentIps.length} 个在岗 IP 进行连通性测试...`);
      const currentTestResults = await Promise.all(currentIps.map(ip => testIp(ip)));
      healthyInPlaceEntries = sortHealthyEntries(currentTestResults);
      console.log(`✅ 在岗检测完成: ${healthyInPlaceEntries.length} 个健康, ${currentIps.length - healthyInPlaceEntries.length} 个失效`);
    }

    if (healthyInPlaceEntries.length >= MAX_IPS) {
      finalHealthyIps = healthyInPlaceEntries.slice(0, MAX_IPS).map(entry => entry.ip);
      console.log('✨ 现有健康 IP 足供使用，无需从池中采集。');
    } else {
      const gapSize = MAX_IPS - healthyInPlaceEntries.length;
      console.log(`补充逻辑激活: 当前还缺少 ${gapSize} 个健康 IP`);

      console.log('📥 正在解析候选 IP 池...');
      const poolIps = await parseIpPool(CF_IP_POOL);

      let candidatePoolIps = poolIps.filter(ip => !currentIps.includes(ip));
      if (POOL_SAMPLE_COUNT > 0 && candidatePoolIps.length > POOL_SAMPLE_COUNT) {
        console.log(`🎲 池中 IP 较多 (${candidatePoolIps.length})，随机抽取 ${POOL_SAMPLE_COUNT} 个进行测试...`);
        shuffleArray(candidatePoolIps);
        candidatePoolIps = candidatePoolIps.slice(0, POOL_SAMPLE_COUNT);
      }

      console.log(`🔍 待补充测试 IP 数量: ${candidatePoolIps.length}`);

      const poolResults = candidatePoolIps.length > 0
        ? await Promise.all(candidatePoolIps.map(ip => testIp(ip)))
        : [];
      const healthyPoolEntries = sortHealthyEntries(poolResults);

      if (candidatePoolIps.length > 0) {
        console.log(`📊 池中优选结果: 发现 ${healthyPoolEntries.length} 个健康 IP`);
      }

      finalHealthyIps = buildFallbackTargetIps(
        healthyInPlaceEntries,
        healthyPoolEntries,
        MAX_IPS,
      );
    }
  }

  if (finalHealthyIps.length === 0) {
    console.error('😱 严重警告: 现有记录及候选池中所有 IP 均不可用！');
    console.error('🚫 脚本已中止，禁止清空 Cloudflare 解析记录。');
    await sendNotification('⚠️ CF 自动故障转移报警', `域名 ${CF_DOMAIN} 的所有 IP（含池中候选）均已宕机！解析已锁定旧状态以防彻底失联。`);
    return;
  }

  if (finalHealthyIps.length < MAX_IPS && finalHealthyIps.length <= NOTIFY_THRESHOLD) {
    console.warn(`💡 IP 池告急: 当前仅余 ${finalHealthyIps.length} 个健康 IP，无法满足目标 ${MAX_IPS} 个（告警阈值: ${NOTIFY_THRESHOLD}）。`);
    await sendNotification('⚠️ CF IP 池告急', `域名 ${CF_DOMAIN} 的健康 IP 补位失败，当前仅剩 ${finalHealthyIps.length} 个可用 IP（阈值: ${NOTIFY_THRESHOLD}）。请及时更新 IP 池！`);
  }

  console.log(`✅ 最终目标 IP 集合: [${finalHealthyIps.join(', ')}]`);

  const toDelete = currentRecords.filter(r => !finalHealthyIps.includes(r.content));
  const toAdd = finalHealthyIps.filter(ip => !currentIps.includes(ip));

  let changeCount = 0;

  for (const record of toDelete) {
    console.log(`🗑️ 正在移除记录: ${record.content} ...`);
    try {
      await cfApiRequest('DELETE', `/zones/${CF_ZONE_ID}/dns_records/${record.id}`);
      changeCount++;
    } catch (e) {
      console.error(`❌ 删除失败: ${e.message}`);
    }
  }

  for (const ip of toAdd) {
    console.log(`➕ 正在新增解析: ${ip} ...`);
    try {
      await cfApiRequest('POST', `/zones/${CF_ZONE_ID}/dns_records`, {
        type: 'A',
        name: CF_DOMAIN,
        content: ip,
        proxied: false,
        ttl: 60
      });
      changeCount++;
    } catch (e) {
      console.error(`❌ 添加失败: ${e.message}`);
    }
  }

  if (changeCount > 0) {
    console.log(`\n🎉 DNS 解析已更新！(高频运行：跳过常规通知)`);
    console.log(`旧状态: [${currentIps.join(', ') || '空'}]`);
    console.log(`新状态: [${finalHealthyIps.join(', ')}]`);
  } else {
    console.log('\n✨ 当前解析记录依然健康且稳定，无变动。');
  }
}

module.exports = {
  buildFallbackTargetIps,
  buildLatencyCandidateIps,
  loadRuntimeConfig,
  normalizeIpUpdateMode,
  parseRuntimeConfig,
  pickTopHealthyIps,
};

if (require.main === module) {
  main().catch(err => {
    console.error(`\n❌ 脚本全局错误: ${err.message}`);
    sendNotification('❌ CF 同步脚本崩溃', err.message);
  });
}

