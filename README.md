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

### 1) `cfst_test.js` - CloudflareSpeedTest 优选脚本

主要职责：

- 📥 自动下载并解压 `CloudflareSpeedTest` 二进制（跨平台识别：Linux / macOS / Windows）
- 🗂️ 读取配置（环境变量、`config.txt`、青龙配置）
- 🌐 从 `IP_SOURCE_URL` / `IP_RANDOM_SOURCE_URL` 获取候选 IP
- 🎲 可对采样池随机抽样，降低测试成本
- ⚙️ 调用 CloudflareSpeedTest 执行延迟 + 下载速度测试
- 📄 解析 `result.csv` 结果并落盘本地文件：
  - `data/cfst_speed_results.txt`（IP + 速度）
  - `data/cfst_valid_ips.txt`（全部达标 IP）
  - `data/cfst_preferred_ips.txt`（优选前 N 个 IP）
- 🔔 支持 `sendNotify.js` 通知（若存在）

一句话：**负责“找出更快的 Cloudflare IP，并把结果保存到本地池”** ⚡

---

### 2) `cf_ip_sync.js` - Cloudflare IP 同步脚本

主要职责：

- 📚 从 IP 池读取候选（支持 URL、本地文件、直接 IP）
- ⚖️ `latency` 模式：对池内全部 IP 做轻量延迟/可用性探测
- 🚀 `speed` 模式：先做轻量探活，再仅对延迟最低的少量候选复用本地 CloudflareST 二进制测速
- ☁️ 可选同步 Cloudflare DNS 解析记录（A 记录）
- 📝 可选同步最终 IP 列表到 Gist
- 📦 可选上传最终 IP 列表到 S3/R2 兼容对象存储
- 🚨 IP 不足时触发告警通知

一句话：**负责“从候选池选出最终 IP，并同步到已配置的输出目标”** 🧭

若同时配置 DNS、Gist、S3/R2，`cf_ip_sync.js` 会并行执行三种输出，并分别汇总结果。

---

## 🔄 推荐运行流程

1. 先跑 `cfst_test.js` 生成优选池 `data/cfst_preferred_ips.txt`  
2. 再由 `cf_ip_sync.js` 按高频周期从池中选出最终 IP 并同步输出目标

可理解为：

- `cfst_test.js` = 选手选拔赛 🏃
- `cf_ip_sync.js` = 从候选名单里持续选出当前最合适的上场节点 🧑‍🔧

---

## ⚙️ 配置说明

项目支持以下配置来源（按脚本逻辑合并）：

- 环境变量（推荐）
- 同目录 `config.txt`
- 青龙配置（`config.json` / `config.sh`）

### `cfst_test.js` 常用变量

- `IP_SOURCE_URL`：固定候选 IP 来源（URL/文件/单个 IP，支持逗号分隔）
- `IP_RANDOM_SOURCE_URL`：随机候选池来源
- `IP_RANDOM_SAMPLE_COUNT`：随机采样数量（默认 300）
- `CFST_LATENCY_THRESHOLD`：延迟阈值 ms（默认 500）
- `DOWNLOAD_SPEED_THRESHOLD_MBPS`：下载速度阈值（默认 10）
- `SPEED_TEST_DURATION_S`：测速时长秒（默认 10）
- `CFST_TEST_COUNT`：参与下载测速的候选数量（默认 30）
- `PREFERRED_IP_COUNT`：最终优选保存数量（默认 10）
- `CFST_SPEED_TEST_URL`：CloudflareST 自定义测速地址（可选）
- `LOCAL_DATA_DIR`：本地数据目录（默认 `./data`）
- `github_proxy`：下载 CloudflareST 的代理前缀（可选）

### `cf_ip_sync.js` 常用变量

- `CF_IP_POOL`：IP 池（URL/文件/IP，逗号分隔）；为空时默认读 `./data/cfst_preferred_ips.txt`
- `IP_UPDATE_MODE`：`latency` 或 `speed`，默认 `latency`
- `MAX_IPS`：最终产出的 IP 数量（代码默认 2；你也可以在 `config.txt` 里按需改大）
- `NOTIFY_THRESHOLD`：告警阈值（默认 2）
- `POOL_SAMPLE_COUNT`：保留兼容，但当前模式下不生效
- `LOCAL_DATA_DIR`：本地数据目录（默认 `./data`）
- `CF_API_TOKEN` / `CF_ZONE_ID` / `CF_DOMAIN`：可选；三者都存在时才同步 DNS
- `GITHUB_TOKEN` / `GIST_NAME`：可选；两者都存在时才同步 Gist
- `GIST_SECRET`：是否创建 secret gist（可选；仅 `true` 视为 secret，其它值都按 public 处理）
- `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` / `S3_KEY` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`：可选；六者都存在时才同步 S3/R2
- `S3_ALLOW_HTTP`：可选；默认 `false`，仅本地调试 MinIO 等明文 HTTP 场景才设为 `true`
- `CFST_LATENCY_THRESHOLD`：`speed` 模式第二阶段复用的 CloudflareST 延迟阈值（默认 500）
- `DOWNLOAD_SPEED_THRESHOLD_MBPS`：`speed` 模式第二阶段复用的下载速度阈值（默认 10）
- `SPEED_TEST_DURATION_S`：`speed` 模式基础测速时长（默认 10）；实际传给 CloudflareST 时会取 `max(3, floor(该值/2))`
- `CFST_TEST_COUNT`：兼容保留；`speed` 模式实际只会把探活成功后按延迟排序的前 `MAX_IPS * 3` 个候选交给 CloudflareST
- `LATENCY_TEST_CONCURRENCY`：`speed` 模式第二阶段复用的并发数（默认 200）
- `CFST_SPEED_TEST_URL`：`speed` 模式第二阶段复用的 CloudflareST 自定义测速地址（可选）

---

## 🏁 快速开始

### 1. 安装依赖

本项目仅使用 Node.js 内置模块，无额外 npm 依赖。  
确保你已安装：

- Node.js 16+
- `curl`、`tar`（macOS/Linux 通常自带）
- Windows 建议准备 unzip 能力（或使用已解压好的 CloudflareST）

### 2. 准备配置（示例）

在项目根目录创建 `config.txt`：

```bash
IP_SOURCE_URL=https://example.com/cf_ips.txt
CFST_LATENCY_THRESHOLD=500
DOWNLOAD_SPEED_THRESHOLD_MBPS=10
PREFERRED_IP_COUNT=10

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
node cfst_test.js
node cf_ip_sync.js
```

---

## ⏰ 定时任务建议

- `cfst_test.js`：低频（例如每天/每周）🗓️
- `cf_ip_sync.js`：高频（例如每 5 分钟）⏱️

这样既能持续刷新优选池，又能及时故障转移。

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
ql repo https://github.com/lee1080/cf_auto_bestip.git "cfst_test|cf_ip_sync" "README|LICENSE" "config" "" "js|txt"
```

参数含义（不同青龙版本参数个数可能不同；下面以此命令为准）：

- 仓库：`https://github.com/lee1080/cf_auto_bestip.git`
- 白名单：`cfst_test|cf_ip_sync`（只拉这两个脚本）
- 黑名单：`README|LICENSE`（不拉文档/协议文件）
- 排除关键字：`config`（避免把 `config` 相关文件当脚本拉取；按你面板规则）
- 分支/其他参数：留空（`""`）
- 文件后缀：`js|txt`（允许拉取 `.js` 和 `.txt`）

### 1.2 名称粘贴模式（部分版本支持）

如果你的青龙版本支持「创建订阅 -> 名称」自动解析，可尝试：

```text
cf_auto_bestip#https://github.com/lee1080/cf_auto_bestip.git#main#cfst_test|cf_ip_sync#README|LICENSE#config##js|txt
```

说明（名称粘贴模式字段顺序）：

- 名称#链接#分支#白名单#黑名单#（其余参数…）
- 本示例与上面的 `ql repo` 命令保持一致：白名单 `cfst_test|cf_ip_sync`，黑名单 `README|LICENSE`，后缀 `js|txt`

若该模式仍不生效，请优先使用上面的 `ql repo` 命令方式。✅

### 2. 任务命令示例

拉库完成后，在「定时任务」中新建两个任务：

- 优选测速任务（低频）：
  - 命令：`task cf_auto_bestip/cfst_test.js`
- DNS 同步任务（高频）：
  - 命令：`task cf_auto_bestip/cf_ip_sync.js`

### 3. 定时建议（Cron）

- `cfst_test.js`：`0 23 * * 4`（每周四 23:00，可按需调整）🗓️
- `cf_ip_sync.js`：`*/5 * * * *`（每 5 分钟）⏱️

### 4. 环境变量配置

在青龙「环境变量」中建议至少配置以下项：

- `IP_SOURCE_URL`（或 `IP_RANDOM_SOURCE_URL`）
- 若需要 DNS 输出：`CF_API_TOKEN`、`CF_ZONE_ID`、`CF_DOMAIN`
- 若需要 Gist 输出：`GITHUB_TOKEN`、`GIST_NAME`

如果你直接在仓库内维护 `config.txt`（且已脱敏），脚本也会自动读取。✅

### 5. 运行顺序建议

- 先手动执行一次 `cfst_test.js`，确认生成 `data/cfst_preferred_ips.txt`
- 再执行 `cf_ip_sync.js`，确认 DNS 可正常更新
- 最后开启定时任务自动运行 🔁

---

## 📁 产物文件

默认在 `data/` 目录：

- `cfst_speed_results.txt` - 测速结果（含速率）
- `cfst_valid_ips.txt` - 达标 IP 列表
- `cfst_preferred_ips.txt` - 优选 IP 池（供 DNS 同步脚本消费）
- `cfst_ips.txt` - 本次测试输入 IP 临时文件
- `result.csv` - CloudflareST 原始结果
- `cf_ip_sync_gist_id.txt` - Gist ID 本地状态文件（删除后下次会新建新的 Gist）

---

## 🔐 安全建议

- ❗不要把真实 `CF_API_TOKEN` 提交到 GitHub
- ✅ 建议提交 `config.example.txt`，把敏感值替换为占位符
- ✅ 建议使用 `.gitignore` 忽略 `data/` 等运行产物（`config.txt` 可按需提交）

---

## 🙌 致谢

- [XIU2/CloudflareSpeedTest](https://github.com/XIU2/CloudflareSpeedTest) 提供核心测速能力
- Cloudflare 提供稳定强大的 DNS API ☁️

---

## 📜 License

本仓库已附带 `MIT License`，可直接用于开源发布 ✅

