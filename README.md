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

### 2) `cf_dns_sync.js` - Cloudflare DNS 自动同步脚本

主要职责：

- ☁️ 读取当前 Cloudflare DNS A 记录
- ❤️ 对“在岗 IP”做实时健康检查（`/cdn-cgi/trace`）
- 📚 从 IP 池补充候选（支持 URL、本地文件、直接 IP）
- 🧪 测试候选可用性并按延迟排序
- ➕➖ 自动新增/删除 DNS 记录，保持目标数量 `MAX_IPS`
- 🛡️ 全部不可用时保护机制触发：**不清空 DNS，避免彻底掉线**
- 🚨 IP 不足时触发告警通知

一句话：**负责“让域名解析始终指向健康可用 IP”** 🧭

---

## 🔄 推荐运行流程

1. 先跑 `cfst_test.js` 生成优选池 `data/cfst_preferred_ips.txt`  
2. 再由 `cf_dns_sync.js` 按高频周期检查并自动同步 DNS

可理解为：

- `cfst_test.js` = 选手选拔赛 🏃
- `cf_dns_sync.js` = 正式比赛实时换人 🧑‍🔧

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
- `CFST_TEST_COUNT`：测速保留数量（默认 30）
- `PREFERRED_IP_COUNT`：最终优选保存数量（默认 10）
- `CFST_SPEED_TEST_URL`：CloudflareST 自定义测速地址（可选）
- `LOCAL_DATA_DIR`：本地数据目录（默认 `./data`）
- `github_proxy`：下载 CloudflareST 的代理前缀（可选）

### `cf_dns_sync.js` 常用变量

- `CF_API_TOKEN`：Cloudflare API Token（必填）
- `CF_ZONE_ID`：Zone ID（必填）
- `CF_DOMAIN`：要维护的域名（必填）
- `CF_IP_POOL`：IP 池（URL/文件/IP，逗号分隔）；为空时默认读 `./data/cfst_preferred_ips.txt`
- `MAX_IPS`：期望维持的 A 记录数量（默认 2）
- `NOTIFY_THRESHOLD`：告警阈值（默认 2）
- `POOL_SAMPLE_COUNT`：池过大时随机抽样测试数量（默认 0=不抽样）
- `LOCAL_DATA_DIR`：本地数据目录（默认 `./data`）

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
```

### 3. 运行脚本

```bash
node cfst_test.js
node cf_dns_sync.js
```

---

## ⏰ 定时任务建议

- `cfst_test.js`：低频（例如每天/每周）🗓️
- `cf_dns_sync.js`：高频（例如每 5 分钟）⏱️

这样既能持续刷新优选池，又能及时故障转移。

---

## 🐉 青龙面板拉库指南

### 1. 添加仓库订阅

在青龙面板中进入「订阅管理」添加订阅，推荐配置：

- 名称：`cf_auto_bestip`
- 类型：`公开仓库`
- 链接：`https://github.com/lee1080/cf_auto_bestip.git`
- 分支：`main`

### 1.1 一键订阅（可直接粘贴到“名称”）

部分青龙版本支持在「创建订阅 -> 名称」中粘贴完整订阅串，一次性自动填充名称、链接、分支、白名单、黑名单。  
可直接复制这一行：

```text
cf_auto_bestip#https://github.com/lee1080/cf_auto_bestip.git#main#cfst_test|cf_dns_sync|config.txt#
```

说明：
- 第 1 段：订阅名称
- 第 2 段：仓库链接
- 第 3 段：分支
- 第 4 段：白名单（拉取 `cfst_test`、`cf_dns_sync`、`config.txt`）
- 第 5 段：黑名单（留空）

如果你的青龙版本不支持该格式，就按上面的“手动配置”方式填写即可。✅

### 2. 任务命令示例

拉库完成后，在「定时任务」中新建两个任务：

- 优选测速任务（低频）：
  - 命令：`task cf_auto_bestip/cfst_test.js`
- DNS 同步任务（高频）：
  - 命令：`task cf_auto_bestip/cf_dns_sync.js`

### 3. 定时建议（Cron）

- `cfst_test.js`：`0 23 * * 4`（每周四 23:00，可按需调整）🗓️
- `cf_dns_sync.js`：`*/5 * * * *`（每 5 分钟）⏱️

### 4. 环境变量配置

在青龙「环境变量」中至少配置以下项：

- `CF_API_TOKEN`
- `CF_ZONE_ID`
- `CF_DOMAIN`
- `IP_SOURCE_URL`（或 `IP_RANDOM_SOURCE_URL`）

如果你直接在仓库内维护 `config.txt`（且已脱敏），脚本也会自动读取。✅

### 5. 运行顺序建议

- 先手动执行一次 `cfst_test.js`，确认生成 `data/cfst_preferred_ips.txt`
- 再执行 `cf_dns_sync.js`，确认 DNS 可正常更新
- 最后开启定时任务自动运行 🔁

---

## 📁 产物文件

默认在 `data/` 目录：

- `cfst_speed_results.txt` - 测速结果（含速率）
- `cfst_valid_ips.txt` - 达标 IP 列表
- `cfst_preferred_ips.txt` - 优选 IP 池（供 DNS 同步脚本消费）
- `cfst_ips.txt` - 本次测试输入 IP 临时文件
- `result.csv` - CloudflareST 原始结果

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

