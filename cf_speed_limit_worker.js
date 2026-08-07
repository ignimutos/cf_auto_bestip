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

// 分片式上游拉取（核心修复）：
// 直接把上游 Range 拆成若干个 ≤CHUNK 的子请求逐段下载，而不是一次拉全量。
// 原因：上游 R2 对 identity 编码的 200MB 文件在中后段会停滞（实测 40MB 后跌到几 KB/s），
// 且 Cloudflare 边缘对流式响应会剥掉 Content-Length 并可能在流未完成时就截断/当作 EOF，
// 导致 CloudflareST 因「未知长度 + EOF」提前终止测速（结果恒偏低或 0）。
// 分段下载保证每次返回长度明确、紧凑短小，既不丢数据，也让限速 pacing 可精确计量。
const UPSTREAM_CHUNK = 16 * MB; // 每段 16MB，避免上游 identity 长连接停滞
const UPSTREAM_CHUNK_QUEUE = 1; // 预取队列长度（仅 1 个 lookahead：隐藏段间网络往返，又不叠太多并发上游连接）
const UPSTREAM_CHUNK_RETRIES = 2; // 单段失败重试次数；最终失败时优雅关闭（输出较短文件），不报硬错误

function pacedChunkedUpstream(upstream, totalBytes, ua, bps) {
  let currentIndex = 0; // 当前正在消费的段号
  let prefetchResolve = null;
  const queue = []; // 已发出的段（按顺序消费）

  const enqueueRequest = (index, attempt = 0) => {
    const rangeStart = index * UPSTREAM_CHUNK;
    const rangeEnd = Math.min(rangeStart + UPSTREAM_CHUNK - 1, totalBytes - 1);
    const h = new Headers();
    if (ua) h.set("user-agent", ua);
    h.set("accept-encoding", "identity");
    h.set("range", `bytes=${rangeStart}-${rangeEnd}`);
    fetch(upstream.toString(), { method: "GET", headers: h })
      .then((resp) => {
        if (!resp.ok || !resp.body) return null;
        return resp.body.getReader();
      })
      .then((reader) => {
        queue[index] = reader || null;
        if (prefetchResolve) {
          prefetchResolve();
          prefetchResolve = null;
        }
      })
      .catch((err) => {
        // 单段失败：有限重试；仍失败则置 null（pull 时优雅关闭，输出较短文件）
        if (attempt < UPSTREAM_CHUNK_RETRIES) {
          enqueueRequest(index, attempt + 1);
        } else {
          queue[index] = null;
          if (prefetchResolve) {
            prefetchResolve();
            prefetchResolve = null;
          }
        }
      });
  };

  const waitForChunk = async (index) => {
    if (queue[index] !== undefined) return queue[index];
    // 等后续预取填充
    await new Promise((resolve) => (prefetchResolve = resolve));
    return queue[index];
  };

  let delivered = 0;
  let startedAt = performance.now();
  let lastEnqueued = -1;
  const fetchNext = () => {
    const index = lastEnqueued + 1;
    if (index * UPSTREAM_CHUNK >= totalBytes) return;
    lastEnqueued = index;
    enqueueRequest(index);
  };
  // 预热预取队列
  for (let i = 0; i < UPSTREAM_CHUNK_QUEUE; i++) fetchNext();

  return new ReadableStream({
    async pull(controller) {
      while (true) {
        if (delivered >= totalBytes) {
          controller.close();
          return;
        }
        const index = currentIndex;
        const reader = await waitForChunk(index);
        currentIndex++;
        // 补充下一个预取请求
        fetchNext();
        if (!reader) {
          // 该段最终失败：优雅关闭（输出较短文件，客户端按已收字节计算）。
          // 相比 controller.error(0 字节)，宁可短文件也不让整次测速归零。
          controller.close();
          return;
        }
        while (delivered < totalBytes) {
          const { done, value } = await reader.read();
          if (done) {
            reader.releaseLock();
            break;
          }
          let chunk = value;
          if (delivered + chunk.byteLength > totalBytes) {
            chunk = chunk.subarray(0, totalBytes - delivered);
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
        }
      }
    },
    cancel() {
      prefetchDone = true;
      try {
        queue.forEach((r) => r && r.cancel && r.cancel());
      } catch (e) {
        /* ignore */
      }
    },
  });
}

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

  // 请求上游的公共头：identity 编码（测速必须按实际字节计量，禁止上游压缩）。
  const upstreamHeaders = new Headers();
  upstreamHeaders.set("user-agent", getUpstreamUa(env, request));
  upstreamHeaders.set("accept-encoding", "identity");

  let respHeaders = new Headers();
  respHeaders.set("cache-control", "no-store, no-cache, must-revalidate");
  respHeaders.set("access-control-allow-origin", "*");
  respHeaders.set(
    "access-control-expose-headers",
    "content-length, content-range",
  );

  // HEAD：不读 body，直接透传上游状态与头部（含 content-length）
  if (request.method === "HEAD") {
    let headResp;
    try {
      headResp = await fetch(upstream.toString(), {
        method: "HEAD",
        headers: upstreamHeaders,
      });
    } catch (err) {
      return new Response(`upstream error: ${err.message}`, { status: 502 });
    }
    for (const [k, v] of headResp.headers.entries()) respHeaders.set(k, v);
    respHeaders.set("cache-control", "no-store, no-cache, must-revalidate");
    respHeaders.set("access-control-allow-origin", "*");
    respHeaders.set(
      "access-control-expose-headers",
      "content-length, content-range",
    );
    respHeaders.delete("content-range");
    return new Response(null, {
      status: headResp.status,
      headers: respHeaders,
    });
  }

  // GET：分片拉取。先用一个最小 Range 探头上游是否支持分段、并拿到文件总长。
  let probe;
  try {
    const probeHeaders = new Headers(upstreamHeaders);
    probeHeaders.set("range", `bytes=0-0`);
    probe = await fetch(upstream.toString(), {
      method: "GET",
      headers: probeHeaders,
    });
  } catch (err) {
    return new Response(`upstream error: ${err.message}`, { status: 502 });
  }
  // 上游不支持 Range（回 200 且无 content-range）：退化为单次全量拉取
  if (probe.status !== 206 || !probe.body) {
    // 仍用分片获取器，但上游返回整段，我们截断到 bytes
    let fullResp;
    try {
      fullResp = await fetch(upstream.toString(), {
        method: "GET",
        headers: upstreamHeaders,
      });
    } catch (err) {
      return new Response(`upstream error: ${err.message}`, { status: 502 });
    }
    if (!fullResp.ok) {
      for (const [k, v] of fullResp.headers.entries()) respHeaders.set(k, v);
      respHeaders.delete("content-range");
      return new Response(null, {
        status: fullResp.status,
        headers: respHeaders,
      });
    }
    const len = Number(fullResp.headers.get("content-length"));
    if (Number.isFinite(len) && len > 0) bytes = Math.min(bytes, len);
    respHeaders.set("content-length", String(bytes));
    return new Response(pacedBody(fullResp.body, bytes, bps), {
      status: 200,
      headers: respHeaders,
    });
  }

  // 上游支持 Range：读取 content-range 里的总文件大小，截断到 bytes
  const cr = probe.headers.get("content-range"); // 形如 bytes 0-0/209715200
  let totalLength = null;
  if (cr) {
    const m = cr.match(/\/(\d+)/);
    if (m) totalLength = Number(m[1]);
  }
  // 探测请求的 body 无需继续读取
  if (probe.body) {
    try {
      await probe.body.cancel();
    } catch (e) {
      /* ignore */
    }
  }
  if (totalLength && totalLength > 0) bytes = Math.min(bytes, totalLength);

  respHeaders.set("content-length", String(bytes));
  const ua = upstreamHeaders.get("user-agent") || "";
  return new Response(pacedChunkedUpstream(upstream, bytes, ua, bps), {
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
