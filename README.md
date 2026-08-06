# 🚀 cf_auto_bestip

> 基于 Node.js 的 Cloudflare IP 优选 + DNS 自动故障转移工具链  
> 一套脚本，打通「测速优选」➡️「自动切换」➡️「稳定保活」🔁

---

## ✨ 项目是做什么的？

这个项目包含两个核心脚本，配合使用可以实现：

- 📡 自动拉取候选 IP（支持 URL、本地文件、直写 IP）
- ⚡ 使用 CloudflareSpeedTest 进行测速和筛选
- 🧠 自动保留低延迟/高可用的优选 IP
- ☁️ 自动同步 Cloudflare DNS 解析记录（A 记录）
- 🛟 故障时自动补位，避免全量失联

---

## 🧩 脚本功能总览

### 1) `cfst_select.js` - CloudflareSpeedTest 优选脚本

主要职责：

- 📥 自动下载并解压 `CloudflareSpeedTest` 二进制（跨平台识别：Linux / macOS / Windows）
- 🗂️ 读取配置（环境变量、本地 `config.txt`、青龙配置）
- 🌐 从 `IP_SOURCE_URL` / `IP_RANDOM_SOURCE_URL` 获取候选 IP
- 🎲 可对采样池随机抽样，降低测试成本
- ⚙️ 调用 CloudflareSpeedTest 执行延迟 + 下载速度测试
- 📄 解析 `data/cfst_select/result.csv` 结果并落盘本地文件：
  - `data/cfst_select/speed_results.txt`（IP + 速度）
  - `data/cfst_select/valid_ips.txt`（全部达标 IP）
  - `data/cfst_select/preferred_ips.txt`（优选前 N 个 IP）
- 🔔 支持 `sendNotify.js` 通知（若存在）

一句话：**负责“找出更快的 Cloudflare IP，并把结果保存到本地池”** ⚡

---

### 2) `ip_sync.js` - IP 同步脚本

主要职责：

- 📚 从 IP 池读取候选（支持 URL、本地文件、直接 IP）
- ⚖️ `latency` 模式：对池内全部 IP 做轻量延迟/可用性探测
- 🚀 `speed` 模式：先做轻量探活，再仅对延迟最低的少量候选复用本地 CloudflareST 二进制测速
- ☁️ 可选同步 Cloudflare DNS 解析记录（A 记录）
- 📝 可选同步最终 IP 列表到 Gist
- 📦 可选上传最终 IP 列表到 S3/R2 兼容对象存储
- 🚨 IP 不足时触发告警通知

一句话：**负责“从候选池选出最终 IP，并同步到已配置的输出目标”** 🧭

若同时配置 DNS、Gist、S3/R2，`ip_sync.js` 会并行执行三种输出，并分别汇总结果。

---

## 🔄 推荐运行流程

1. 先跑 `cfst_select.js` 生成优选池 `data/cfst_select/preferred_ips.txt`  
2. 再由 `ip_sync.js` 按高频周期从池中选出最终 IP 并同步输出目标

可理解为：

- `cfst_select.js` = 选手选拔赛 🏃
- `ip_sync.js` = 从候选名单里持续选出当前最合适的上场节点 🧑‍🔧

---

## ⚙️ 配置说明

项目支持以下配置来源（按脚本逻辑合并）：

- 环境变量（推荐）
- 同目录 `config.txt`（建议由 `config.example.txt` 复制得到，仅本地使用）
- 青龙配置（`config.json` / `config.sh`）

### `cfst_select.js` 常用变量

- `IP_SOURCE_URL`：固定候选 IP 来源（URL/文件/单个 IP，支持逗号分隔）
- `IP_RANDOM_SOURCE_URL`：随机候选池来源
- `IP_RANDOM_SAMPLE_COUNT`：随机采样数量（默认 300）
- `CFST_SELECT_LATENCY_THRESHOLD`：延迟阈值 ms（默认 500）
- `CFST_SELECT_DOWNLOAD_SPEED_THRESHOLD_MBPS`：下载速度阈值（默认 10）
- `CFST_SELECT_SPEED_TEST_DURATION_S`：测速时长秒（默认 10）
- `CFST_SELECT_TEST_COUNT`：参与下载测速的候选数量（默认 30）
- `CFST_SELECT_LATENCY_TEST_CONCURRENCY`：CloudflareST 并发数（默认 200）
- `PREFERRED_IP_COUNT`：最终优选保存数量（默认 10）
- `CFST_SELECT_SPEED_TEST_URL`：CloudflareST 自定义测速地址（可选）
- `LOCAL_DATA_DIR`：本地数据目录（默认 `./data`）
- `github_proxy`：下载 CloudflareST 的代理前缀（可选）

### `ip_sync.js` 常用变量

- `CF_IP_POOL`：IP 池（URL/文件/IP，逗号分隔）；为空时默认读 `./data/cfst_select/preferred_ips.txt`
- `IP_UPDATE_MODE`：`latency` 或 `speed`，默认 `latency`
- `IP_UPDATE_STRATEGY`：`default` 或 `lazy`，默认 `default`。`lazy` 时优先对上次使用的 IP 列表按当前模式重新测速（延迟模式做延迟探活，下载测速模式跑 CloudflareST），可用 IP 仍 >= `MAX_IPS` 则直接复用、本轮跳过上传；否则回退到对完整候选池测速
- `MAX_IPS`：最终产出的 IP 数量（代码默认 2；你也可以在 `config.txt` 里按需改大）
- `NOTIFY_THRESHOLD`：告警阈值（默认等于 `MAX_IPS`）
- `LOCAL_DATA_DIR`：本地数据目录（默认 `./data`）
- `CF_API_TOKEN` / `CF_ZONE_ID` / `CF_DOMAIN`：可选；三者都存在时才同步 DNS
- `GITHUB_TOKEN` / `GIST_NAME`：可选；两者都存在时才同步 Gist
- `GIST_SECRET`：是否创建 secret gist（可选；仅 `true` 视为 secret，其它值都按 public 处理）
- `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` / `S3_KEY` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`：可选；六者都存在时才同步 S3/R2
- `S3_ALLOW_HTTP`：可选；默认 `false`，仅本地调试 MinIO 等明文 HTTP 场景才设为 `true`
- `IP_SYNC_LATENCY_THRESHOLD`：优先使用；未设置时回退到 `CFST_SELECT_LATENCY_THRESHOLD`
- `IP_SYNC_TEST_COUNT`：优先使用；未设置时回退到 `CFST_SELECT_TEST_COUNT`
- `IP_SYNC_LATENCY_TEST_CONCURRENCY`：优先使用；未设置时回退到 `CFST_SELECT_LATENCY_TEST_CONCURRENCY`
- `IP_SYNC_DOWNLOAD_SPEED_THRESHOLD_MBPS`：优先使用；未设置时回退到 `CFST_SELECT_DOWNLOAD_SPEED_THRESHOLD_MBPS`
- `IP_SYNC_SPEED_TEST_URL`：优先使用；未设置时回退到 `CFST_SELECT_SPEED_TEST_URL`
- `IP_SYNC_SPEED_TEST_DURATION_S`：若设置则直接传给 CloudflareST；未设置时才基于 `CFST_SELECT_SPEED_TEST_DURATION_S` 计算 `max(3, floor(x/2))`
- `IP_SYNC_SPEED_CANDIDATE_COUNT`：若设置则直接作为 `speed` 模式二阶段候选数量；未设置时才按 `MAX_IPS * 3` 计算

---

## 🏁 快速开始

### 1. 安装依赖

本项目仅使用 Node.js 内置模块，无额外 npm 依赖。  
确保你已安装：

- Node.js 16+
- `curl`、`tar`（macOS/Linux 通常自带）
- Windows 建议准备 unzip 能力（或使用已解压好的 CloudflareST）

### 2. 准备配置（本地）

先在项目根目录复制模板：

```bash
cp config.example.txt config.txt
```

`config.txt` 仅本地使用，已被 `.gitignore` 忽略；请勿提交，尤其不要提交任何密钥。

然后按需编辑 `config.txt`，例如：

```bash
IP_SOURCE_URL=https://example.com/cf_ips.txt
CFST_SELECT_LATENCY_THRESHOLD=500
CFST_SELECT_DOWNLOAD_SPEED_THRESHOLD_MBPS=10
CFST_SELECT_SPEED_TEST_DURATION_S=10
CFST_SELECT_TEST_COUNT=30
CFST_SELECT_LATENCY_TEST_CONCURRENCY=200
PREFERRED_IP_COUNT=10

IP_SYNC_LATENCY_THRESHOLD=
IP_SYNC_TEST_COUNT=
IP_SYNC_LATENCY_TEST_CONCURRENCY=
IP_SYNC_DOWNLOAD_SPEED_THRESHOLD_MBPS=
IP_SYNC_SPEED_TEST_DURATION_S=
IP_SYNC_SPEED_TEST_URL=
IP_SYNC_SPEED_CANDIDATE_COUNT=

CF_API_TOKEN=your_token
CF_ZONE_ID=your_zone_id
CF_DOMAIN=example.com
MAX_IPS=2
GITHUB_TOKEN=your_github_token
GIST_NAME=cf_ips.txt
GIST_SECRET=false
S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=cloudflare-ips
S3_KEY=best-ip.txt
S3_ACCESS_KEY_ID=your_access_key_id
S3_SECRET_ACCESS_KEY=your_secret_access_key
```

### 3. 运行脚本

```bash
node cfst_select.js
node ip_sync.js
```

---

## ⏰ 定时任务建议

- `cfst_select.js`：低频（例如每天/每周）🗓️
- `ip_sync.js`：高频（例如每 5 分钟）⏱️

这样既能持续刷新优选池，又能及时故障转移。

---

## 📡 可选：测速文件中转限速 Worker

默认情况下，CloudflareST 的下载测速直接请求 `speed.cloudflare.com/__down`，走的是 CF 公网测速节点，下载速率不可控。

仓库根目录提供了一份 Cloudflare Worker 示例代码 **`cf_speed_limit_worker.js`**，可以把测速文件地址中转到自己部署的域名上，并按需限制下载速率：

- 每个候选 IP 的实测下载速率被限制在可配置范围（默认 10 MB/s），避免全速下载拖垮出口带宽
- 限速后，凡是能达到限速值的 IP 都是“达标”IP，更利于横向比较筛选
- 强制每次回源、禁用缓存，确保测到被测 IP 的真实速度
- 显式返回 `Content-Length` 并精确下发请求的字节数，确保 CloudflareST 能正确计量速度

### 1. 部署 Worker

新建 Worker（`wrangler` 或控制台面板均可），代码直接粘贴 `cf_speed_limit_worker.js` 内容，无需任何依赖。面板方式更简单：**Workers → 创建 Worker → 粘贴代码 → 部署**。

也可用 `wrangler` 部署：

```bash
wrangler deploy cf_speed_limit_worker.js --name cf-speed-limit
```

### 2. 可选环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `UPSTREAM_URL` | `https://cf.xiu2.xyz/url` | 上游测速文件地址（CloudflareST 同款默认；建议部署时改成你自己的、对 HTTP/2 放行的地址，见下方说明；勿指向 Worker 自身） |
| `UPSTREAM_UA` | 自动 | 请求上游时的浏览器 UA；未设置时用客户端 UA，客户端也没有则用 CFST 同款 UA 兜底 |
| `SPEED_LIMIT` | `50m` | 限速值，支持 `512k` / `10m` / `1g`（裸数字按 MB/s） |
| `DEFAULT_BYTES` | `104857600` | 未传 `bytes` 时的默认下载量（字节） |
| `MAX_BYTES` | `1073741824` | 单次下载量硬上限（字节），防止滥用 |

控制台在 Worker 的「设置 → 变量」中添加，或写入 `wrangler.toml`：

```toml
name = "cf-speed-limit"
main = "cf_speed_limit_worker.js"
compatibility_date = "2024-01-01"

[vars]
# UPSTREAM_URL = "https://speed.cloudflare.com/__down"  # 建议改成对 HTTP/2 放行的地址
# UPSTREAM_UA = "Mozilla/5.0 ..."                       # 可选，指定上游请求的 UA
SPEED_LIMIT = "50m"
# DEFAULT_BYTES = 104857600                             # 未传 bytes 时的默认下载量
# MAX_BYTES = 1073741824                                # 单次下载硬上限
```

### 3. 在本项目中使用

测速地址为：

```
https://<worker-domain>/__down?bytes=104857600
```

**只需配置 `CFST_SELECT_SPEED_TEST_URL` 一个变量**即可让两个脚本都生效——`ip_sync.js` 的 `IP_SYNC_SPEED_TEST_URL` 为空时自动回退到它：

```bash
CFST_SELECT_SPEED_TEST_URL=https://<worker-domain>/__down?bytes=104857600
```

配置后，`cfst_select.js` 和 `ip_sync.js` 的下载测速都会走这个限速地址。若不想限速，把 `bytes` 调大即可（上限由 `MAX_BYTES` 控制）。

> 也可单独给 `ip_sync.js` 配不同的地址：设置 `IP_SYNC_SPEED_TEST_URL` 后优先用它，留空则用 `CFST_SELECT_SPEED_TEST_URL`。

> ⚠️ **踩坑提示（重要）**
>
> 1. **`UPSTREAM_URL` 不能指向 Worker 自己**：如果把 `UPSTREAM_URL` 设成 `https://<worker-domain>/__down`，会形成「/__down → 自身 → /__down」的**无限递归**，Cloudflare 边缘直接返回 **HTTP 522**。本示例已内置防自指检测（同 hostname 且路径为 `/__down` 时自动回退默认上游），但请勿故意这样配置。上游应指向一个真实的测速文件。
> 2. **默认上游 `cf.xiu2.xyz/url` 可能被 403**：这是 CloudflareST 的默认地址，但它**对 HTTP/2 请求返回 403**（Cloudflare 的 bot 防护）。CloudflareST 本地能用它，是因为它自定义了 `DialContext` 导致 Go 走 **HTTP/1.1 → 302 → 成功**；而 **Worker 的 `fetch()` 强制走 HTTP/2**，所以 `cf.xiu2.xyz/url` 在 Worker 里可能直接 403。**建议部署时把 `UPSTREAM_URL` 改成对 HTTP/2 放行的地址**（如 `speed.cloudflare.com/__down`，或你自己部署的测速文件）。
> 3. **限速值要高于测速门槛**：`SPEED_LIMIT` 必须大于 `IP_SYNC_DOWNLOAD_SPEED_THRESHOLD_MBPS`（否则没有 IP 能“达标”，结果恒为空）。例如门槛 10 MB/s，限速建议设 `15m` 或更高（默认 `50m` 已覆盖绝大多数场景）。
> 4. **Workers 的 TransformStream 不可用于限速**：Cloudflare Workers 只支持 identity TransformStream（原样转发），自定义 `transform` 处理器（含 `await sleep`）会**导致流提前断流**，表现为“浏览器能下载、但 CloudflareST 测速恒为 0”。本示例用 `ReadableStream` 的 pull 模式实现限速，避开了这个坑。
> 5. **不要自己拼 `bytes` 太大导致超时**：下载量越大，单请求限速耗时越久（`bytes / SPEED_LIMIT`）。Workers 免费版对单请求有执行时长限制，测速文件建议控制在 50–200 MB，并把 `bytes` 与测速时长匹配。
> 6. **限速实现别用「每 chunk 至少睡 1ms」**：旧版 `pacedBody` 用 `sleep(Math.max(1, chunk/bps))`，上游若返回小 chunk（几 KB），实际吞吐会被钳死到 `chunk大小/1ms` ≈ 3–5 MB/s，即使 `SPEED_LIMIT` 配了 `50m` 也到不了，导致测速门槛永远不达标。新版改为时间预算式限速（只在前发超前时补睡差额，上游慢时如实反映），若发现中转被压到几 MB/s 请更新到最新代码。

---

## 🐉 青龙面板拉库指南

### 1. 添加仓库订阅

在青龙面板中进入「订阅管理」添加订阅，推荐配置：

- 名称：`cf_auto_bestip`
- 类型：`公开仓库`
- 链接：`https://github.com/lee1080/cf_auto_bestip.git`
- 分支：`main`

### 1.1 一键拉库（推荐：`ql repo` 命令）

你可以直接在青龙容器内执行（成功率最高）：

```bash
ql repo https://github.com/lee1080/cf_auto_bestip.git "cfst_select|ip_sync" "README|LICENSE" "utils" "" "js|txt"
```

参数含义（不同青龙版本参数个数可能不同；下面以此命令为准）：

- 仓库：`https://github.com/lee1080/cf_auto_bestip.git`
- 白名单：`cfst_select|ip_sync`（只拉两个入口脚本，避免 `utils/shared.js` 出现在任务列表里）
- 黑名单：`README|LICENSE`（不拉文档/协议文件）
- 依赖文件：`utils`（把 `utils/shared.js` 作为依赖拷贝到仓库目录）
- 分支：留空（默认分支）
- 文件后缀：`js|txt`（允许拉取 `.js` 和 `.txt`）

### 1.2 名称粘贴模式（部分版本支持）

如果你的青龙版本支持「创建订阅 -> 名称」自动解析，可尝试：

```text
cf_auto_bestip#https://github.com/lee1080/cf_auto_bestip.git#main#cfst_select|ip_sync#README|LICENSE#utils##js|txt
```

说明（名称粘贴模式字段顺序）：

- 名称#链接#分支#白名单#黑名单#（其余参数…）
- 本示例与上面的 `ql repo` 命令保持一致：白名单 `cfst_select|ip_sync`，黑名单 `README|LICENSE`，依赖文件 `utils`，后缀 `js|txt`
- 这样入口脚本仍然只有 `cfst_select.js` 和 `ip_sync.js`，而 `utils/shared.js` 会作为依赖文件同步，不会单独出现在任务列表中。

若该模式仍不生效，请优先使用上面的 `ql repo` 命令方式。✅

### 2. 任务命令示例

拉库完成后，在「定时任务」中新建两个任务：

- 优选测速任务（低频）：
  - 命令：`task cf_auto_bestip/cfst_select.js`
- DNS 同步任务（高频）：
  - 命令：`task cf_auto_bestip/ip_sync.js`

### 3. 定时建议（Cron）

- `cfst_select.js`：`0 23 * * 4`（每周四 23:00，可按需调整）🗓️
- `ip_sync.js`：`*/5 * * * *`（每 5 分钟）⏱️

### 4. 环境变量配置

在青龙「环境变量」中建议至少配置以下项：

- `IP_SOURCE_URL`（或 `IP_RANDOM_SOURCE_URL`）
- 若需要 DNS 输出：`CF_API_TOKEN`、`CF_ZONE_ID`、`CF_DOMAIN`
- 若需要 Gist 输出：`GITHUB_TOKEN`、`GIST_NAME`

如需使用文件配置，请在本地复制 `config.example.txt` 为 `config.txt`；`config.txt` 不应提交。✅

### 5. 运行顺序建议

- 先手动执行一次 `cfst_select.js`，确认生成 `data/cfst_select/preferred_ips.txt`
- 再执行 `ip_sync.js`，确认 DNS 可正常更新
- 最后开启定时任务自动运行 🔁

---

## 📁 产物文件

默认在 `data/` 目录下按脚本拆分：

### `data/cfst_select/`

- `speed_results.txt` - 测速结果（含速率）
- `valid_ips.txt` - 达标 IP 列表
- `preferred_ips.txt` - 优选 IP 池（供 `ip_sync.js` 默认读取）
- `ips.txt` - 本次测试输入 IP 临时文件
- `result.csv` - CloudflareST 原始结果

### `data/ip_sync/`

- `preferred_ips.txt` - `ip_sync.js` 最终选出的本地结果文件
- `ips.txt` - `speed` 模式二阶段测速输入 IP 临时文件
- `result.csv` - `speed` 模式二阶段 CloudflareST 原始结果
- `gist_id.txt` - Gist ID 本地状态文件（删除后下次会新建新的 Gist）

其中：`data/cfst_select/preferred_ips.txt` 是上游优选池，`data/ip_sync/preferred_ips.txt` 是下游最终结果；若本次没有可用 IP，`ip_sync.js` 会保留该文件原有内容，首次运行且无结果时则创建空文件。

---

## 🔐 安全建议

- ❗不要把真实 `CF_API_TOKEN` 提交到 GitHub
- ✅ 建议提交 `config.example.txt`，把敏感值替换为占位符
- ✅ 建议使用 `.gitignore` 忽略 `data/` 等运行产物，`config.txt` 仅本地使用且不应提交

---

## 🙌 致谢

- [XIU2/CloudflareSpeedTest](https://github.com/XIU2/CloudflareSpeedTest) 提供核心测速能力
- Cloudflare 提供稳定强大的 DNS API ☁️

---

## 📜 License

本仓库已附带 `MIT License`，可直接用于开源发布 ✅

