/**
 * Cloudflare Worker —— 测速文件中转限速
 *
 * 用途：
 *   把 CloudflareSpeedTest（及本项目 cfst_select.js / ip_sync.js）的下载测速地址，
 *   中转到一个 Cloudflare Worker，并对下载速率做限速：
 *     - 绕开 speed.cloudflare.com 的公网测速节点，改走自己部署的域名；
 *     - 每个候选 IP 的实测下载速率被限制在可配置范围，避免全速下载拖垮出口带宽；
 *     - 限速后，凡是能达到限速值的 IP 都是“达标”IP，更利于横向比较筛选。
 *
 * 部署：
 *   面板直接粘贴本文件即可（无需依赖），参考 README「📡 可选：测速文件中转限速 Worker」。
 *
 * 测速地址：
 *   https://<worker-domain>/__down?bytes=104857600
 *   可同时配置到本项目的：
 *     CFST_SELECT_SPEED_TEST_URL / IP_SYNC_SPEED_TEST_URL
 */

// 以下默认值均可被环境变量覆盖：
//   UPSTREAM_URL      上游测速文件地址
//   UPSTREAM_UA       请求上游时用的浏览器 UA（客户端没带 UA 时兜底）
//   SPEED_LIMIT       限速（如 512k / 10m / 1g，裸数字按 MB/s）
//   DEFAULT_BYTES     bytes 参数缺省时的下载量（字节）
//   MAX_BYTES         单次下载量硬上限（字节，防止滥用）
//
// 默认上游用 CloudflareST 同款地址 cf.xiu2.xyz/url。
// ⚠️ 注意：cf.xiu2.xyz/url 对 HTTP/2 请求有 bot 防护（Worker fetch 走 HTTP/2，可能 403）。
// 若你的 Worker 访问它被 403，请把 UPSTREAM_URL 设为对 HTTP/2 放行的测速文件地址
// （如 speed.cloudflare.com/__down，或你自己部署的地址）。
const DEFAULT_UPSTREAM_URL = "https://cf.xiu2.xyz/url";
const FALLBACK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.80 Safari/537.36";
const DEFAULT_SPEED_LIMIT = "50m";
const DEFAULT_BYTES = 200 * 1024 * 1024;
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;

const KB = 1024;
const MB = 1024 * KB;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 解析限速值：'512k' / '10m' / '1g' / '10'（裸数字按 MB/s 处理），返回字节/秒
export function parseSpeedLimit(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([kmg]?)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2];
  if (unit === "k") return n * KB;
  if (unit === "g") return n * MB * 1024;
  return n * MB; // 'm' 或缺省均按 MB/s
}

function getSpeedLimit(env) {
  return (
    parseSpeedLimit(env.SPEED_LIMIT ?? env.SPEED_LIMIT_MBPS) ||
    parseSpeedLimit(DEFAULT_SPEED_LIMIT)
  );
}

function getMaxBytes(env) {
  const raw = Number(env.MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_BYTES;
}

function getDefaultBytes(env) {
  const raw = Number(env.DEFAULT_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BYTES;
}

// 请求上游时的 UA：环境变量 UPSTREAM_UA 优先，其次客户端 UA，最后兜底浏览器 UA
function getUpstreamUa(env, request) {
  const fromEnv = String(env.UPSTREAM_UA || "").trim();
  if (fromEnv) return fromEnv;
  return request.headers.get("user-agent") || FALLBACK_UA;
}

// 限速透传：从上游流读取，最多送出 `bytes` 字节，速率限制在 `bps` 字节/秒。
// 注意：不用 TransformStream + sleep 实现（Cloudflare Workers 只支持 identity TransformStream，
// 自定义 transform 处理器不可靠，会导致流提前断流），改用 ReadableStream 的 pull 模式，
// 这是 Workers 完整支持、可配合 await 限速的可靠写法。
function pacedBody(upstreamBody, bytes, bps) {
  const reader = upstreamBody.getReader();
  let delivered = 0;
  let startedAt = performance.now();
  return new ReadableStream({
    async pull(controller) {
      if (delivered >= bytes) {
        controller.close();
        try {
          await reader.cancel();
        } catch (e) {
          /* ignore */
        }
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      let chunk = value;
      if (delivered + chunk.byteLength > bytes) {
        chunk = chunk.subarray(0, bytes - delivered);
      }
      delivered += chunk.byteLength;
      controller.enqueue(chunk);
      if (bps > 0) {
        // 时间预算式限速：按累计已发字节折算应耗时，与实际耗时比较。
        // 只有“超前发送”时才 sleep 补齐差额；上游/链路本身慢时不额外等待，
        // 如实反映真实速率。避免“每 chunk 至少睡 1ms”把小 chunk 压到几 MB/s。
        const budgetMs = (delivered / bps) * 1000;
        const elapsedMs = performance.now() - startedAt;
        const slackMs = Math.round(budgetMs - elapsedMs);
        if (slackMs > 0) await sleep(slackMs);
      }
    },
    cancel() {
      try {
        reader.cancel();
      } catch (e) {
        /* ignore */
      }
    },
  });
}

function resolveUpstream(env, request) {
  let configured = String(env.UPSTREAM_URL || "").trim();
  if (!configured) configured = DEFAULT_UPSTREAM_URL;
  try {
    const u = new URL(configured);
    // 防自指递归：若上游指向 Worker 自己（同 hostname 且也是 /__down），
    // 回退到默认上游，避免 /__down -> 自身 -> /__down 无限递归导致 522
    if (
      u.hostname === new URL(request.url).hostname &&
      u.pathname === "/__down"
    ) {
      return new URL(DEFAULT_UPSTREAM_URL);
    }
    return u;
  } catch (err) {
    // 上游 URL 解析失败（如少了协议），回退默认
    return new URL(DEFAULT_UPSTREAM_URL);
  }
}

async function proxyDown(request, env) {
  const params = new URL(request.url).searchParams;

  // 计算本次下载量：未指定用默认，超过硬上限则截断
  let bytes = getDefaultBytes(env);
  const rawBytes = Number(params.get("bytes"));
  if (Number.isFinite(rawBytes) && rawBytes > 0) {
    bytes = Math.min(rawBytes, getMaxBytes(env));
  }

  const bps = getSpeedLimit(env);

  // 拼接上游地址：保留 UPSTREAM_URL 自带参数，再覆盖/追加本次请求参数
  const upstream = resolveUpstream(env, request);
  for (const [k, v] of params.entries()) upstream.searchParams.set(k, v);
  upstream.searchParams.set("bytes", String(bytes));

  // Range：客户端带了就透传；否则主动请求所需字节区间。
  // ⚠️ R2 / 静态文件会忽略 URL 查询参数（如 ?bytes=xxx），总是返回完整文件；
  //    只有 Range 头能让它只返回所需部分，避免每次拉全量、长下载停滞。
  const upstreamHeaders = new Headers();
  const clientRange = request.headers.get("range");
  if (clientRange) {
    upstreamHeaders.set("range", clientRange);
  } else {
    upstreamHeaders.set("range", `bytes=0-${bytes - 1}`);
  }
  upstreamHeaders.set("user-agent", getUpstreamUa(env, request));
  upstreamHeaders.set("accept-encoding", "identity");

  let upstreamResp;
  try {
    const method = request.method === "HEAD" ? "HEAD" : "GET";
    upstreamResp = await fetch(upstream.toString(), {
      method,
      headers: upstreamHeaders,
    });
  } catch (err) {
    return new Response(`upstream error: ${err.message}`, { status: 502 });
  }

  const respHeaders = new Headers(upstreamResp.headers);
  // 禁用缓存：测速必须每次回源，否则命中就近缓存就测不到被测 IP 的真实速度
  respHeaders.set("cache-control", "no-store, no-cache, must-revalidate");
  respHeaders.set("access-control-allow-origin", "*");
  respHeaders.set(
    "access-control-expose-headers",
    "content-length, content-range",
  );
  // 下游始终按单段 200 返回：清掉上游 206 的 content-range，避免混淆字节语义
  respHeaders.delete("content-range");

  // HEAD 或上游未返回 body：原样透传状态即可
  if (
    request.method === "HEAD" ||
    upstreamResp.status === 204 ||
    !upstreamResp.body
  ) {
    return new Response(null, {
      status: upstreamResp.status,
      headers: respHeaders,
    });
  }
  // 上游出错（如 403/404）：透传状态码，不包装成 200
  // 注意：206 是合法的分段响应（我们主动发 Range 时上游回 206），必须和 200 一样透传 body
  if (upstreamResp.status !== 200 && upstreamResp.status !== 206) {
    return new Response(null, {
      status: upstreamResp.status,
      headers: respHeaders,
    });
  }

  // 关键：把实际会下发的字节数写进 Content-Length。
  // CloudflareST 若读到 content-length 为 -1（未知长度）会直接终止测速，结果恒为 0。
  // 上游若已知长度且更小，则以下游真实长度为准。
  const upstreamLength = Number(upstreamResp.headers.get("content-length"));
  if (Number.isFinite(upstreamLength) && upstreamLength > 0) {
    bytes = Math.min(bytes, upstreamLength);
  }
  respHeaders.set("content-length", String(bytes));

  return new Response(pacedBody(upstreamResp.body, bytes, bps), {
    status: 200,
    headers: respHeaders,
  });
}

function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "access-control-allow-headers": "range",
      "access-control-max-age": "86400",
    },
  });
}

function infoPage(env) {
  const bps = getSpeedLimit(env);
  const configured = String(env.UPSTREAM_URL || "").trim() || "(使用默认)";
  const configuredUa = String(env.UPSTREAM_UA || "").trim() || "(自动)";
  const lines = [
    "Cloudflare Worker —— 测速文件中转限速",
    "",
    `UPSTREAM_URL (配置): ${configured}`,
    `UPSTREAM_URL (默认): ${DEFAULT_UPSTREAM_URL}`,
    `UPSTREAM_UA (配置) : ${configuredUa}`,
    `SPEED_LIMIT        : ${env.SPEED_LIMIT ?? env.SPEED_LIMIT_MBPS ?? DEFAULT_SPEED_LIMIT}  (≈ ${(bps / MB).toFixed(1)} MB/s)`,
    `DEFAULT_BYTES      : ${getDefaultBytes(env)} bytes`,
    `MAX_BYTES          : ${getMaxBytes(env)} bytes`,
    "",
    "测速地址示例：/__down?bytes=104857600",
    "部署文档：README「📡 可选：测速文件中转限速 Worker」",
  ];
  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return corsPreflight();

    const url = new URL(request.url);
    if (url.pathname === "/") return infoPage(env);
    if (url.pathname === "/__down") return proxyDown(request, env);

    return new Response("Not Found", { status: 404 });
  },
};
