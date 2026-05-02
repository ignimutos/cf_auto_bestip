// cron "*/5 * * * *" cf_ip_sync.js, tag:Cloudflare IP同步
function Env(name) { this.name = name; }
const syncEnv = new Env('Cloudflare IP同步');
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
const os = require('os');
const { spawn } = require('child_process');
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
const GIST_ID_STATE_FILE = path.join(__dirname, 'data', 'cf_ip_sync_gist_id.txt');
const CFST_CANDIDATES = os.platform() === 'win32'
  ? ['CloudflareST.exe', 'cfst.exe']
  : ['CloudflareST', 'cfst'];

// --- 配置区域 (优先从环境变量读取) ---
function normalizeIpUpdateMode(rawMode) {
  return rawMode === 'speed' ? 'speed' : 'latency';
}

function parseBooleanEnv(rawValue) {
  return String(rawValue || '').trim().toLowerCase() === 'true';
}

function getMissingCloudflareOutputConfig(config) {
  return ['CF_API_TOKEN', 'CF_ZONE_ID', 'CF_DOMAIN'].filter((key) => !config[key]);
}

function getMissingGistOutputConfig(config) {
  return ['GITHUB_TOKEN', 'GIST_NAME'].filter((key) => !config[key]);
}

function hasCloudflareOutput(config) {
  return getMissingCloudflareOutputConfig(config).length === 0;
}

function hasGistOutput(config) {
  return getMissingGistOutputConfig(config).length === 0;
}

function formatGistIpContent(ips) {
  return ips.join('\n');
}

function formatInputSourceSummary({ directCount, urlCount, fileCount }) {
  return `📋 输入来源: 直接 IP ${directCount} 个 | 远程 URL ${urlCount} 个 | 本地文件 ${fileCount} 个`;
}

function formatLatencySelectionSummary(selection) {
  return [
    '📊 Latency 全量探测结果:',
    ...selection.allResults.map((result) => result.success
      ? `   - ${result.ip} | ${result.latency} ms`
      : `   - ${result.ip} | ${result.reason || 'failed'}`),
    '✅ Latency 最终保留结果:',
    ...selection.finalResults.map((result) => `   - ${result.ip} | ${result.latency} ms`),
  ];
}

function formatSpeedSelectionSummary(selection) {
  return [
    '📊 Speed 候选测速结果:',
    ...selection.allResults.map((result) => `   - ${result.ip} | ${result.speed.toFixed(2)} MB/s`),
    '✅ Speed 最终保留结果:',
    ...selection.finalResults.map((result) => `   - ${result.ip} | ${result.speed.toFixed(2)} MB/s`),
  ];
}

function formatSelectionOutput(selection) {
  const summaryLines = selection.mode === 'speed'
    ? formatSpeedSelectionSummary(selection)
    : formatLatencySelectionSummary(selection);

  return [
    ...summaryLines,
    `✅ 最终目标 IP 集合: [${selection.finalHealthyIps.join(', ')}]`,
  ].join('\n');
}

function formatDnsOutputSummary(output) {
  if (!output.triggered) {
    return `ℹ️ Cloudflare DNS: 已跳过，缺少配置: ${output.missingConfig.join(', ')}`;
  }
  if (!output.result) return '';
  return `☁️ Cloudflare DNS 结果: 当前 ${output.result.currentIps.length} 条 | 计划新增 ${output.result.toAdd.length} | 计划删除 ${output.result.toDelete.length} | 成功 ${output.result.successfulChangeCount} | 失败 ${output.result.failedChangeCount}`;
}

function formatGistOutputSummary(output) {
  if (!output.triggered) {
    return `ℹ️ Gist: 已跳过，缺少配置: ${output.missingConfig.join(', ')}`;
  }
  if (!output.result) return '';
  return `📝 Gist 结果: ${output.result.action} | gistId ${output.result.gistId} | 文件 ${output.filename}`;
}

function readGistIdStateFile(filePath = GIST_ID_STATE_FILE) {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8').trim();
}

function writeGistIdStateFile(gistId, filePath = GIST_ID_STATE_FILE) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${gistId}\n`, 'utf8');
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
    GITHUB_TOKEN: env.GITHUB_TOKEN,
    GIST_NAME: (env.GIST_NAME || '').trim(),
    GIST_SECRET: parseBooleanEnv(env.GIST_SECRET),
    CFST_LATENCY_THRESHOLD: parseInt(env.CFST_LATENCY_THRESHOLD, 10) || 500,
    DOWNLOAD_SPEED_THRESHOLD_MBPS: parseFloat(env.DOWNLOAD_SPEED_THRESHOLD_MBPS) || 10,
    SPEED_TEST_DURATION_S: parseInt(env.SPEED_TEST_DURATION_S, 10) || 10,
    CFST_TEST_COUNT: parseInt(env.CFST_TEST_COUNT, 10) || 30,
    LATENCY_TEST_CONCURRENCY: parseInt(env.LATENCY_TEST_CONCURRENCY, 10) || 200,
    CFST_SPEED_TEST_URL: env.CFST_SPEED_TEST_URL || '',
  };
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
        console.log(`   ✅ 远程 URL: ${url} -> ${ips.length} 个 IP`);
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
    console.log(`   ✅ 本地文件: ${filePath} -> ${ips.length} 个 IP`);
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

  console.log(formatInputSourceSummary({
    directCount: directIps.length,
    urlCount: urlItems.length,
    fileCount: fileItems.length,
  }));

  const remoteResults = await Promise.all(urlItems.map(url => fetchIpsFromUrl(url)));
  const remoteIps = remoteResults.flat();
  const localIps = fileItems.flatMap(fp => readIpsFromLocalFile(fp));

  return Array.from(new Set([...directIps, ...remoteIps, ...localIps]));
}

function findBinaryRecursive(dir, targetNames) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      const found = findBinaryRecursive(fullPath, targetNames);
      if (found) return found;
    } else if (targetNames.includes(file)) {
      return fullPath;
    }
  }
  return '';
}

function findExistingCfstBinary(startDir = __dirname) {
  return findBinaryRecursive(startDir, CFST_CANDIDATES);
}

function parseCfstCsvResults(csvPath) {
  const data = fs.readFileSync(csvPath, 'utf8');
  const lines = data.split('\n').filter(Boolean);
  return lines.slice(1).map(line => {
    const cols = line.split(',');
    return {
      ip: cols[0],
      speed: parseFloat(cols[5]),
    };
  }).filter(result => result.ip && !Number.isNaN(result.speed));
}

async function defaultRunCfst({ cfstBinaryPath, inputFilePath, resultCsvPath, config }) {
  const args = [
    '-f', inputFilePath,
    '-tl', String(config.CFST_LATENCY_THRESHOLD),
    '-sl', String(config.DOWNLOAD_SPEED_THRESHOLD_MBPS),
    '-dn', String(config.CFST_TEST_COUNT || Math.max(config.MAX_IPS, 10)),
    '-dt', String(config.SPEED_TEST_DURATION_S),
    '-n', String(config.LATENCY_TEST_CONCURRENCY),
  ];

  if (config.CFST_SPEED_TEST_URL) {
    args.push('-url', config.CFST_SPEED_TEST_URL);
  }

  await new Promise((resolve, reject) => {
    const child = spawn(cfstBinaryPath, args, { stdio: 'inherit', cwd: path.dirname(resultCsvPath) });
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`CloudflareST exited with code ${code}`)));
    child.on('error', reject);
  });
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

function githubApiRequest(method, apiPath, token, data = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      port: 443,
      path: apiPath,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'cf_auto_bestip',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = body ? JSON.parse(body) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(new Error(json.message || `GitHub API ${res.statusCode}`));
        } catch (e) {
          reject(new Error(`解析 GitHub 响应失败: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

async function createGist(token, filename, content, isSecret, apiRequest = githubApiRequest) {
  return apiRequest('POST', '/gists', token, {
    public: !isSecret,
    files: {
      [filename]: {
        content,
      },
    },
  });
}

async function updateGist(token, gistId, filename, content, apiRequest = githubApiRequest) {
  return apiRequest('PATCH', `/gists/${gistId}`, token, {
    files: {
      [filename]: {
        content,
      },
    },
  });
}

async function syncGistIpList(config, finalHealthyIps, deps = {}) {
  const stateFilePath = deps.stateFilePath || GIST_ID_STATE_FILE;
  const apiRequest = deps.githubApiRequest || githubApiRequest;
  const content = formatGistIpContent(finalHealthyIps);
  const gistId = readGistIdStateFile(stateFilePath);

  if (gistId) {
    await updateGist(config.GITHUB_TOKEN, gistId, config.GIST_NAME, content, apiRequest);
    return { action: 'updated', gistId };
  }

  const created = await createGist(
    config.GITHUB_TOKEN,
    config.GIST_NAME,
    content,
    config.GIST_SECRET,
    apiRequest,
  );

  if (!created || !created.id) {
    throw new Error('创建 Gist 响应缺少 gist id');
  }

  writeGistIdStateFile(created.id, stateFilePath);
  return { action: 'created', gistId: created.id };
}

function sortHealthyEntries(results) {
  return results
    .filter(result => result.success)
    .sort((a, b) => a.latency - b.latency);
}

function buildLatencySelection(results, maxIps) {
  const healthyResults = sortHealthyEntries(results);
  const failedResults = results
    .filter(result => !result.success)
    .map(result => ({
      ip: result.ip,
      success: false,
      reason: result.reason || 'failed',
    }));
  const finalResults = healthyResults.slice(0, maxIps);

  return {
    mode: 'latency',
    allResults: [...healthyResults, ...failedResults],
    finalResults,
    finalHealthyIps: finalResults.map(result => result.ip),
  };
}

async function selectIpsByLatency(poolIps, config, deps = {}) {
  const probe = deps.testIp || testIp;
  const results = poolIps.length > 0
    ? await Promise.all(poolIps.map(ip => probe(ip)))
    : [];

  return buildLatencySelection(results, config.MAX_IPS);
}

function buildSpeedSelection(results, maxIps) {
  const finalResults = results.slice(0, maxIps);

  return {
    mode: 'speed',
    allResults: results,
    finalResults,
    finalHealthyIps: finalResults.map(result => result.ip),
  };
}

function getSpeedModeDurationSeconds(durationSeconds) {
  return Math.max(3, Math.floor(Number(durationSeconds) / 2));
}

function getSpeedModeCandidateCount(maxIps) {
  return Math.max(1, Number(maxIps) * 3);
}

async function selectIpsBySpeed(poolIps, config, deps = {}) {
  const probe = deps.testIp || testIp;
  const probeResults = poolIps.length > 0
    ? await Promise.all(poolIps.map(ip => probe(ip)))
    : [];
  const candidates = sortHealthyEntries(probeResults)
    .slice(0, getSpeedModeCandidateCount(config.MAX_IPS))
    .map(result => result.ip);

  if (candidates.length === 0) {
    return buildSpeedSelection([], config.MAX_IPS);
  }

  const dataDir = deps.dataDir || DATA_DIR;
  const inputFilePath = path.join(dataDir, 'cf_ip_sync_cfst_ips.txt');
  const resultCsvPath = path.join(dataDir, 'result.csv');
  const cfstBinaryPath = deps.cfstBinaryPath || (deps.findExistingCfstBinary || findExistingCfstBinary)(__dirname);

  if (!cfstBinaryPath) {
    throw new Error('未找到 CloudflareST，可先运行 cfst_test.js');
  }

  fs.writeFileSync(inputFilePath, candidates.join('\n'), 'utf8');
  if (fs.existsSync(resultCsvPath)) fs.unlinkSync(resultCsvPath);

  const runCfst = deps.runCfst || defaultRunCfst;
  const speedConfig = {
    ...config,
    SPEED_TEST_DURATION_S: getSpeedModeDurationSeconds(config.SPEED_TEST_DURATION_S),
    CFST_TEST_COUNT: candidates.length,
  };
  await runCfst({ cfstBinaryPath, inputFilePath, resultCsvPath, config: speedConfig });

  return buildSpeedSelection(parseCfstCsvResults(resultCsvPath), config.MAX_IPS);
}

async function applyDnsChanges({ currentRecords, finalHealthyIps, zoneId, domain, apiRequest = cfApiRequest }) {
  const currentIps = currentRecords.map(r => r.content);
  const toDelete = currentRecords.filter(r => !finalHealthyIps.includes(r.content));
  const toAdd = finalHealthyIps.filter(ip => !currentIps.includes(ip));

  let successfulChangeCount = 0;
  let failedChangeCount = 0;

  for (const ip of toAdd) {
    console.log(`➕ 正在新增解析: ${ip} ...`);
    try {
      await apiRequest('POST', `/zones/${zoneId}/dns_records`, {
        type: 'A',
        name: domain,
        content: ip,
        proxied: false,
        ttl: 60,
      });
      successfulChangeCount++;
    } catch (e) {
      failedChangeCount++;
      console.error(`❌ 添加失败: ${e.message}`);
    }
  }

  for (const record of toDelete) {
    console.log(`🗑️ 正在移除记录: ${record.content} ...`);
    try {
      await apiRequest('DELETE', `/zones/${zoneId}/dns_records/${record.id}`, null);
      successfulChangeCount++;
    } catch (e) {
      failedChangeCount++;
      console.error(`❌ 删除失败: ${e.message}`);
    }
  }

  return {
    currentIps,
    toDelete,
    toAdd,
    plannedChangeCount: toDelete.length + toAdd.length,
    successfulChangeCount,
    failedChangeCount,
  };
}

async function fetchCurrentDnsRecords(config, apiRequest = cfApiRequest) {
  return apiRequest('GET', `/zones/${config.CF_ZONE_ID}/dns_records?name=${config.CF_DOMAIN}&type=A`);
}

async function syncOutputs(config, finalHealthyIps, deps = {}) {
  const fetchDns = deps.fetchCurrentDnsRecords || fetchCurrentDnsRecords;
  const applyDns = deps.applyDnsChanges || applyDnsChanges;
  const syncGist = deps.syncGistIpList || syncGistIpList;
  const outputs = {
    dns: {
      triggered: false,
      missingConfig: getMissingCloudflareOutputConfig(config),
      result: null,
      error: null,
    },
    gist: {
      triggered: false,
      missingConfig: getMissingGistOutputConfig(config),
      result: null,
      error: null,
      filename: config.GIST_NAME || '',
    },
  };

  if (outputs.dns.missingConfig.length === 0) {
    console.log('☁️ Cloudflare DNS: 已触发');
    outputs.dns.triggered = true;
    try {
      const currentRecords = await fetchDns(config, deps.cfApiRequest || cfApiRequest);
      outputs.dns.result = await applyDns({
        currentRecords,
        finalHealthyIps,
        zoneId: config.CF_ZONE_ID,
        domain: config.CF_DOMAIN,
        apiRequest: deps.cfApiRequest || cfApiRequest,
      });
    } catch (error) {
      outputs.dns.error = error.message;
      console.error(`❌ DNS 同步失败: ${error.message}`);
    }
  }

  if (outputs.gist.missingConfig.length === 0) {
    console.log('📝 Gist: 已触发');
    outputs.gist.triggered = true;
    try {
      outputs.gist.result = await syncGist(config, finalHealthyIps, deps.gistDeps || {});
    } catch (error) {
      outputs.gist.error = error.message;
      console.error(`❌ Gist 同步失败: ${error.message}`);
    }
  }

  const dnsSummary = formatDnsOutputSummary(outputs.dns);
  if (dnsSummary) console.log(dnsSummary);

  const gistSummary = formatGistOutputSummary(outputs.gist);
  if (gistSummary) console.log(gistSummary);

  if (!outputs.dns.triggered && !outputs.gist.triggered) {
    console.log('ℹ️ 未配置任何输出目标，仅输出最终 IP 结果。');
  }

  return outputs;
}

async function runSync(config = loadRuntimeConfig(), deps = {}) {
  const loadPool = deps.parseIpPool || parseIpPool;
  const pickByLatency = deps.selectIpsByLatency || selectIpsByLatency;
  const pickBySpeed = deps.selectIpsBySpeed || selectIpsBySpeed;
  const notify = deps.sendNotification || sendNotification;
  const writeOutputs = deps.syncOutputs || syncOutputs;

  const poolIps = await loadPool(config.CF_IP_POOL);
  if (poolIps.length === 0) {
    throw new Error('IP 池为空，无法继续同步');
  }

  const selection = config.IP_UPDATE_MODE === 'speed'
    ? await pickBySpeed(poolIps, config, deps)
    : await pickByLatency(poolIps, config, deps);
  const finalHealthyIps = selection.finalHealthyIps;

  if (finalHealthyIps.length === 0) {
    await notify('⚠️ CF IP 同步报警', '候选池中没有可用 IP。');
    return {
      poolIps,
      selection,
      finalHealthyIps,
      outputs: {
        dns: {
          triggered: false,
          missingConfig: getMissingCloudflareOutputConfig(config),
          result: null,
          error: null,
        },
        gist: {
          triggered: false,
          missingConfig: getMissingGistOutputConfig(config),
          result: null,
          error: null,
          filename: config.GIST_NAME || '',
        },
      },
    };
  }

  if (finalHealthyIps.length < config.MAX_IPS && finalHealthyIps.length <= config.NOTIFY_THRESHOLD) {
    await notify('⚠️ CF IP 池告急', `当前仅剩 ${finalHealthyIps.length} 个可用 IP（目标: ${config.MAX_IPS}）。`);
  }

  const outputs = await writeOutputs(config, finalHealthyIps, deps);
  return { poolIps, selection, finalHealthyIps, outputs };
}

async function main() {
  const config = loadRuntimeConfig();
  console.log('\n🚀 开始执行 Cloudflare IP 同步...');
  console.log(`数据目录: ${DATA_DIR}`);
  console.log(`输出模式: ${config.IP_UPDATE_MODE}`);

  const result = await runSync(config);
  console.log(formatSelectionOutput(result.selection));
}

module.exports = {
  applyDnsChanges,
  fetchCurrentDnsRecords,
  formatDnsOutputSummary,
  formatGistIpContent,
  formatGistOutputSummary,
  formatInputSourceSummary,
  formatLatencySelectionSummary,
  formatSelectionOutput,
  formatSpeedSelectionSummary,
  getMissingCloudflareOutputConfig,
  getMissingGistOutputConfig,
  getSpeedModeCandidateCount,
  getSpeedModeDurationSeconds,
  hasCloudflareOutput,
  hasGistOutput,
  loadRuntimeConfig,
  normalizeIpUpdateMode,
  parseBooleanEnv,
  parseRuntimeConfig,
  readGistIdStateFile,
  runSync,
  selectIpsByLatency,
  selectIpsBySpeed,
  syncGistIpList,
  syncOutputs,
  writeGistIdStateFile,
};

if (require.main === module) {
  main().catch(err => {
    console.error(`\n❌ 脚本全局错误: ${err.message}`);
    sendNotification('❌ CF IP 同步脚本崩溃', err.message);
  });
}

