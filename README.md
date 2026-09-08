# 🕊️ Human-as-a-Service (真·人工大模型)

> **别人以为在调最新的顶尖大模型，其实屏幕背后是你本尊在现场手打！**

一个将你自己伪装成标准 **OpenAI 兼容接口 (`/v1/chat/completions`)** 的轻量级 Web 服务。朋友可以在任何支持 OpenAI 格式的软件（如 NextChat、Cherry Studio、Chatbox 等）里调用你的接口，而你在手机上通过 **Telegram 机器人** 或 **微信风格的专属网页工作台** 实时接收并回复提问！

---

## ✨ 核心特性

- 🤖 **标准 OpenAI 接口兼容**：兼容 `/v1/chat/completions` 与 `/v1/models`，支持流式 SSE 打字机效果与非流式单次输出。
- 🛡️ **首次连接实名登记认证**：新朋友第一次发消息时，系统自动拦截并要求回复 `我是: 名字` 完成登记，未认证前不打扰你，认证后自动建立专属档案！
- 💬 **微信式单人专属独立对话框**：网页端采用移动端原生级滑动架构，点开谁就跟谁聊，互不串台。
- 🖼️ **视觉多模态能力 (Vision)**：支持接收朋友发来的图片，原图直接推送给你的 Telegram 与网页端。
- ⏳ **10分钟充裕回复倒计时**：内置 3 秒高频心跳保活（Keep-Alive），连接绝不断开，顶部显示实时倒计时。
- ⚡ **连环追问（大模型成精模式）**：在对方发完一句话后，你可以连续发送多句话，对方屏幕会一段接一段吐字，宛如大模型拥有自我意识！
- 💌 **离线时空留言箱**：朋友没上线时可以给 Ta 预留悄悄话，下次 Ta 刚打开客户端发第一句话时立刻置顶弹出！
- 🔔 **Telegram 移动端推送**：手机无需挂网页，TG 机器人直接私聊弹窗，长按消息点回复即可传回。

---

## 🚀 3 分钟一键部署 (Zeabur)

### 第一步：获取 Telegram 机器人参数（可选，但推荐）
1. 在 Telegram 搜索并进入 `@BotFather`，发送 `/newbot` 创建一个机器人，获取 `HTTP API Token`。
2. 搜索并进入 `@userinfobot`，点击 Start 获取你的纯数字 `Id`。
3. 进入你刚创建的机器人，点击底部的 **Start** 激活对话。

### 第二步：在 Zeabur 部署
1. Fork 本仓库到你的 GitHub。
2. 登录 [Zeabur](https://zeabur.com)，创建项目并点击 **Deploy from GitHub**，选择你 Fork 的仓库。
3. 在 **Variables（变量）** 中添加以下环境变量：

```env
PORT=3000
MODEL_NAME=gugu-bot
API_KEY=你的调用密码(如sk-123456,留空则不校验)
TELEGRAM_BOT_TOKEN=你的TG机器人Token
TELEGRAM_ADMIN_CHAT_ID=你的TG数字ID
REPLY_TIMEOUT_SECONDS=600
TIMEOUT_FALLBACK_TEXT=（大模型算力节点过热，思考超时啦，请再试一次～）
```

4. 在 **Networking（网络）** 点击 **Generate Domain** 生成公网域名（如 `my-human-gpt.zeabur.app`）。

---

## 📱 使用指南

### 1. 发给朋友的配置
- **API 地址 (Base URL)**: `https://你的域名.zeabur.app/v1`
- **API Key**: 填你在环境变量里设置的 `API_KEY`
- **模型名称 (Model)**: 填你在环境变量里设置的 `MODEL_NAME` (默认 `gugu-bot`)

### 2. 你的回复工作台
用手机浏览器直接访问：
👉 `https://你的域名.zeabur.app/admin`
- 挂在后台有清脆新消息提示音。
- 点击朋友卡片进入单人专属聊天室。
- 支持连环追发、留言投递、改备注等全部功能！

---

## 📄 开源协议
MIT License
