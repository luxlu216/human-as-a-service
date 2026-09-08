import express from 'express';
import dotenv from 'dotenv';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Telegraf } from 'telegraf';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const MODEL_NAME = process.env.MODEL_NAME || 'gugu-bot';
const API_KEY = process.env.API_KEY || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'cyr0111';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '';

let DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
} catch (e) {
  DATA_DIR = '/tmp/gugu_data';
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {}
}

const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const REPLY_TIMEOUT_SECONDS = parseInt(process.env.REPLY_TIMEOUT_SECONDS || '600', 10);
const TIMEOUT_FALLBACK_TEXT = process.env.TIMEOUT_FALLBACK_TEXT || '（gugu-bot 算力节点过热，思考超时啦，请再问一次试试～）';

const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();
const pendingRequests = new Map();
const tgMessageToRequestId = new Map();
const adminTokens = new Set();

function loadSessionsFromDisk() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        for (const s of list) {
          sessions.set(s.id, {
            ...s,
            pendingRequestId: null,
            pendingStartTime: null
          });
        }
        console.log(`📂 已从数据盘恢复 ${list.length} 位朋友的会话历史与备注！`);
      }
    }
  } catch (err) {
    console.warn('读取持久化数据提示:', err.message);
  }
}

function saveSessionsToDisk() {
  try {
    const list = Array.from(sessions.values()).map(s => ({
      ...s,
      pendingRequestId: null,
      pendingStartTime: null
    }));
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(list, null, 2), 'utf-8');
  } catch (err) {
    console.warn('持久化写入数据盘提示:', err.message);
  }
}

loadSessionsFromDisk();

function getSessionFingerprint(req, messages) {
  const customUser = req.body.user || '';
  let firstSnippet = '';
  for (const m of messages) {
    if (m.role === 'user') {
      firstSnippet = typeof m.content === 'string' ? m.content.slice(0, 30) : 'multimodal';
      break;
    }
  }

  let matchedSessionId = null;
  for (const [id, s] of sessions.entries()) {
    if (s.isRegistered && s.firstSnippet && s.firstSnippet === firstSnippet) {
      matchedSessionId = id;
      break;
    }
  }

  if (matchedSessionId) {
    const s = sessions.get(matchedSessionId);
    return { sessionId: s.id, ip: req.ip || '127.0.0.1', userAgent: req.headers['user-agent'] || 'OpenAI-Client' };
  }

  const hash = crypto.createHash('md5').update(`${customUser}_${firstSnippet}`).digest('hex').slice(0, 8);
  return {
    sessionId: `session_${hash}`,
    ip: req.ip || '127.0.0.1',
    userAgent: req.headers['user-agent'] || 'OpenAI-Client',
    firstSnippet
  };
}

function maskIp(ip) {
  if (!ip) return '未知';
  const parts = ip.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.*.*`;
  return ip.slice(0, 8);
}

function parseClientName(ua) {
  if (!ua) return '通用客户端';
  if (ua.includes('CherryStudio')) return 'Cherry Studio';
  if (ua.includes('NextChat') || ua.includes('ChatGPT-Next-Web')) return 'NextChat';
  if (ua.includes('Chatbox')) return 'Chatbox';
  if (ua.includes('OkHttp')) return '移动端 App';
  if (ua.includes('Mozilla')) return 'Web 网页端';
  return ua.split('/')[0].slice(0, 15);
}

function parseRegistrationName(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  const patterns = [
    /^(?:我是|名字|姓名|叫我|name)[\s:：]+([^\n\r]{1,20})$/i,
    /^我是([^\s:：\n\r]{1,15})$/,
    /^(?:my name is)[\s:：]+([^\n\r]{1,20})$/i
  ];
  for (const p of patterns) {
    const match = t.match(p);
    if (match && match[1]) {
      const name = match[1].replace(/[`*_\~#]/g, '').trim();
      if (name.length >= 1 && name.length <= 20) return name;
    }
  }
  return null;
}

let bot = null;
if (TELEGRAM_BOT_TOKEN) {
  try {
    bot = new Telegraf(TELEGRAM_BOT_TOKEN);

    bot.on('text', async (ctx) => {
      const chatId = String(ctx.chat.id);
      if (TELEGRAM_ADMIN_CHAT_ID && chatId !== String(TELEGRAM_ADMIN_CHAT_ID)) {
        await ctx.reply('⚠️ 未授权用户。');
        return;
      }

      const replyToMsg = ctx.message.reply_to_message;
      let targetRequestId = null;

      if (replyToMsg && tgMessageToRequestId.has(replyToMsg.message_id)) {
        targetRequestId = tgMessageToRequestId.get(replyToMsg.message_id);
      } else if (pendingRequests.size === 1) {
        targetRequestId = pendingRequests.keys().next().value;
      } else if (pendingRequests.size > 1) {
        await ctx.reply('⚠️ 多个朋友正在等待回复，请长按对应提问卡片点【回复】，或打开网页专属独立对话框回复！');
        return;
      } else {
        await ctx.reply('ℹ️ 当前没有等待回复的提问。');
        return;
      }

      if (targetRequestId && pendingRequests.has(targetRequestId)) {
        const replyText = ctx.message.text;
        resolveChatRequest(targetRequestId, replyText, false);
        await ctx.reply(`✅ 回复已送达客户端！`);
      } else {
        await ctx.reply('⚠️ 请求已失效或已超时。');
      }
    });

    bot.launch().then(() => {
      console.log(' Telegram Bot 启动成功！');
    }).catch(err => {
      console.error('❌ TG 启动失败:', err.message);
    });
  } catch (e) {
    console.error('TG 初始化错误:', e.message);
  }
}

function parseBase64Image(dataStr) {
  const matches = dataStr.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/s);
  if (matches && matches.length === 3) {
    const mime = matches[1];
    const ext = mime.split('/')[1] || 'jpg';
    const buffer = Buffer.from(matches[2].replace(/\s/g, ''), 'base64');
    return { buffer, ext, filename: `image.${ext}` };
  }
  try {
    const clean = dataStr.replace(/^data:image\/\w+;base64,/i, '').replace(/\s/g, '');
    const buffer = Buffer.from(clean, 'base64');
    return { buffer, ext: 'jpg', filename: 'image.jpg' };
  } catch (e) {
    return null;
  }
}

async function notifyTelegram(requestId, session, userMessage, images = []) {
  if (!bot || !TELEGRAM_ADMIN_CHAT_ID) return;
  const sessionName = session.alias || `朋友 (${maskIp(session.clientIp)})`;
  let text = `🕊️ *来自【${sessionName}】的新提问！*\n\n`;
  text += `⏰ *时间*: ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}\n`;
  text += `📱 *客户端*: ${session.clientName}\n`;
  text += `⏳ *等待限制*: 10 分钟 (请从容回复)\n`;
  if (session.systemPrompt) {
    const snippetPrompt = session.systemPrompt.length > 80 ? session.systemPrompt.slice(0, 80) + '...' : session.systemPrompt;
    text += `📜 *人设/System*: _${snippetPrompt}_\n`;
  }
  if (images.length > 0) text += `🖼️ *附带图片*: ${images.length} 张\n`;
  text += `💬 *提问*: *${userMessage || '（仅发送图片）'}*\n\n`;
  text += `👉 *操作*: 长按回复，或在网页端打开【${sessionName}】的专属对话框查看完整 Prompt 并回复！`;

  try {
    const sent = await bot.telegram.sendMessage(TELEGRAM_ADMIN_CHAT_ID, text, { parse_mode: 'Markdown' });
    tgMessageToRequestId.set(sent.message_id, requestId);

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      try {
        let sentPhoto = null;
        const caption = `🖼️ 来自【${sessionName}】的图片 [${i + 1}/${images.length}]`;
        if (typeof img === 'string' && img.startsWith('data:')) {
          const parsed = parseBase64Image(img);
          if (parsed && parsed.buffer) {
            try {
              sentPhoto = await bot.telegram.sendPhoto(TELEGRAM_ADMIN_CHAT_ID, { source: parsed.buffer }, { caption });
            } catch (err1) {
              sentPhoto = await bot.telegram.sendDocument(TELEGRAM_ADMIN_CHAT_ID, { source: parsed.buffer, filename: parsed.filename }, { caption });
            }
          }
        } else if (typeof img === 'string' && (img.startsWith('http://') || img.startsWith('https://'))) {
          sentPhoto = await bot.telegram.sendPhoto(TELEGRAM_ADMIN_CHAT_ID, img, { caption });
        }
        if (sentPhoto) tgMessageToRequestId.set(sentPhoto.message_id, requestId);
      } catch (e) {}
    }
  } catch (err) {
    console.error('TG 发送失败:', err.message);
  }
}

function sendDirectSystemReply(res, stream, model, messageText) {
  const createdTime = Math.floor(Date.now() / 1000);
  const completionId = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const chunkRole = {
      id: completionId,
      object: 'chat.completion.chunk',
      created: createdTime,
      model: model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
    };
    res.write(`data: ${JSON.stringify(chunkRole)}\n\n`);

    const chunkContent = {
      id: completionId,
      object: 'chat.completion.chunk',
      created: createdTime,
      model: model,
      choices: [{ index: 0, delta: { content: messageText }, finish_reason: null }]
    };
    res.write(`data: ${JSON.stringify(chunkContent)}\n\n`);

    const chunkDone = {
      id: completionId,
      object: 'chat.completion.chunk',
      created: createdTime,
      model: model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
    };
    res.write(`data: ${JSON.stringify(chunkDone)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } else {
    res.json({
      id: completionId,
      object: 'chat.completion',
      created: createdTime,
      model: model,
      choices: [{ index: 0, message: { role: 'assistant', content: messageText }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: messageText.length, total_tokens: 10 + messageText.length }
    });
  }
}

function resolveChatRequest(requestId, content, keepAlive = false) {
  const reqData = pendingRequests.get(requestId);
  if (!reqData || reqData.isResolved) return;

  const { sessionId, res, stream, model, completionId } = reqData;
  const createdTime = Math.floor(Date.now() / 1000);

  const sess = sessions.get(sessionId);
  if (sess) {
    sess.lastActiveAt = Date.now();
    sess.history.push({
      role: 'assistant',
      content: content,
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false })
    });
    saveSessionsToDisk();
  }

  if (stream) {
    try {
      if (!reqData.hasSentRole) {
        const chunkRole = {
          id: completionId,
          object: 'chat.completion.chunk',
          created: createdTime,
          model: model,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
        };
        res.write(`data: ${JSON.stringify(chunkRole)}\n\n`);
        reqData.hasSentRole = true;
      }

      const formattedContent = (reqData.totalSentCount > 0 ? '\n\n' : '') + content;
      const chunkContent = {
        id: completionId,
        object: 'chat.completion.chunk',
        created: createdTime,
        model: model,
        choices: [{ index: 0, delta: { content: formattedContent }, finish_reason: null }]
      };
      res.write(`data: ${JSON.stringify(chunkContent)}\n\n`);
      reqData.totalSentCount = (reqData.totalSentCount || 0) + 1;

      if (keepAlive) {
        clearTimeout(reqData.timer);
        reqData.timer = setTimeout(() => {
          if (pendingRequests.has(requestId)) {
            finishStream(requestId);
          }
        }, 300 * 1000);
      } else {
        finishStream(requestId);
      }
    } catch (err) {
      console.error('流式发送异常:', err.message);
      finishStream(requestId);
    }
  } else {
    reqData.isResolved = true;
    clearTimeout(reqData.timer);
    if (reqData.heartbeatTimer) clearInterval(reqData.heartbeatTimer);
    pendingRequests.delete(requestId);
    if (sess) {
      sess.pendingRequestId = null;
      sess.pendingStartTime = null;
    }

    try {
      res.json({
        id: completionId,
        object: 'chat.completion',
        created: createdTime,
        model: model,
        choices: [{ index: 0, message: { role: 'assistant', content: content }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: reqData.userMessage?.length || 10,
          completion_tokens: content.length,
          total_tokens: (reqData.userMessage?.length || 10) + content.length
        }
      });
    } catch (err) {
      console.error('非流式返回失败:', err.message);
    }
  }
}

function finishStream(requestId) {
  const reqData = pendingRequests.get(requestId);
  if (!reqData) return;

  reqData.isResolved = true;
  clearTimeout(reqData.timer);
  if (reqData.heartbeatTimer) clearInterval(reqData.heartbeatTimer);
  pendingRequests.delete(requestId);

  const sess = sessions.get(reqData.sessionId);
  if (sess) {
    sess.pendingRequestId = null;
    sess.pendingStartTime = null;
    saveSessionsToDisk();
  }

  try {
    const chunkDone = {
      id: reqData.completionId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: reqData.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
    };
    reqData.res.write(`data: ${JSON.stringify(chunkDone)}\n\n`);
    reqData.res.write('data: [DONE]\n\n');
    reqData.res.end();
  } catch (e) {}
}

function authenticate(req, res, next) {
  if (!API_KEY) return next();
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (token !== API_KEY) {
    return res.status(401).json({
      error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' }
    });
  }
  next();
}

function requireAdminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ error: '需要密码认证后才能访问工作台' });
  }
  next();
}

function extractImagesFromMessages(messages) {
  const images = [];
  if (!Array.isArray(messages)) return images;
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const content = m.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === 'image_url') {
          const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
          if (url) images.push(url);
        } else if (part.type === 'image') {
          const data = part.source?.data;
          const mime = part.source?.media_type || 'image/jpeg';
          if (data) images.push(`data:${mime};base64,${data}`);
          else if (part.url) images.push(part.url);
        }
      }
    } else if (typeof content === 'string') {
      const mdRegex = /!\[.*?\]\((https?:\/\/[^\s\)]+|data:image\/[a-zA-Z]+;base64,[^\s\)]+)\)/g;
      let match;
      while ((match = mdRegex.exec(content)) !== null) images.push(match[1]);
      if (content.startsWith('data:image/') && content.includes(';base64,')) images.push(content);
    }
  }
  return images;
}

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) {
    const token = crypto.randomBytes(24).toString('hex');
    adminTokens.add(token);
    return res.json({ success: true, token });
  }
  return res.status(401).json({ success: false, error: '访问口令错误！' });
});

app.get('/api/sessions', requireAdminAuth, (req, res) => {
  const list = Array.from(sessions.values()).map(s => {
    const isPending = Boolean(s.pendingRequestId && pendingRequests.has(s.pendingRequestId));
    const lastMsg = s.history[s.history.length - 1];
    return {
      id: s.id,
      alias: s.alias,
      isRegistered: Boolean(s.isRegistered),
      clientIp: s.clientIp,
      clientName: s.clientName,
      isPending,
      pendingStartTime: s.pendingStartTime || null,
      mailboxCount: (s.mailbox || []).length,
      pendingRequestId: isPending ? s.pendingRequestId : null,
      lastMessage: lastMsg ? (lastMsg.content || '[图片]') : '开始对话',
      lastActiveAt: s.lastActiveAt,
      messageCount: s.history.length,
      hasSystemPrompt: Boolean(s.systemPrompt)
    };
  }).sort((a, b) => {
    if (a.isPending && !b.isPending) return -1;
    if (!a.isPending && b.isPending) return 1;
    return b.lastActiveAt - a.lastActiveAt;
  });

  res.json({ total: list.length, sessions: list, timeoutSeconds: REPLY_TIMEOUT_SECONDS });
});

app.get('/api/session/:id', requireAdminAuth, (req, res) => {
  const sess = sessions.get(req.params.id);
  if (!sess) return res.status(404).json({ error: '会话不存在' });
  const isPending = Boolean(sess.pendingRequestId && pendingRequests.has(sess.pendingRequestId));
  res.json({
    ...sess,
    isPending,
    pendingRequestId: isPending ? sess.pendingRequestId : null,
    pendingStartTime: sess.pendingStartTime || null,
    mailbox: sess.mailbox || [],
    systemPrompt: sess.systemPrompt || '',
    timeoutSeconds: REPLY_TIMEOUT_SECONDS
  });
});

app.post('/api/session/:id/alias', requireAdminAuth, (req, res) => {
  const { alias } = req.body;
  const sess = sessions.get(req.params.id);
  if (!sess) return res.status(404).json({ error: '会话不存在' });
  sess.alias = (alias || '').trim() || `朋友 (${maskIp(sess.clientIp)})`;
  sess.isRegistered = true;
  saveSessionsToDisk();
  res.json({ success: true, alias: sess.alias });
});

app.post('/api/reply', requireAdminAuth, (req, res) => {
  const { requestId, content, keepAlive = false } = req.body;
  if (!requestId || !content) return res.status(400).json({ error: '参数缺失' });
  if (!pendingRequests.has(requestId)) return res.status(404).json({ error: '该提问已过期或已被回复' });
  resolveChatRequest(requestId, content, Boolean(keepAlive));
  res.json({ success: true, keepAlive: Boolean(keepAlive) });
});

app.post('/api/finish', requireAdminAuth, (req, res) => {
  const { requestId } = req.body;
  if (requestId && pendingRequests.has(requestId)) {
    finishStream(requestId);
  }
  res.json({ success: true });
});

app.post('/api/session/:id/mailbox', requireAdminAuth, (req, res) => {
  const { content } = req.body;
  const sess = sessions.get(req.params.id);
  if (!sess) return res.status(404).json({ error: '会话不存在' });
  if (!content || !content.trim()) return res.status(400).json({ error: '留言内容不能为空' });

  if (!sess.mailbox) sess.mailbox = [];
  const mailItem = {
    id: crypto.randomUUID().slice(0, 8),
    content: content.trim(),
    createdAt: new Date().toLocaleTimeString('zh-CN', { hour12: false })
  };
  sess.mailbox.push(mailItem);

  sess.history.push({
    role: 'assistant',
    content: `💌 [已预存主动留言]: "${content.trim()}"`,
    time: mailItem.createdAt
  });

  saveSessionsToDisk();
  res.json({ success: true, mailbox: sess.mailbox });
});

app.delete('/api/session/:id/mailbox/:mailId', requireAdminAuth, (req, res) => {
  const sess = sessions.get(req.params.id);
  if (!sess || !sess.mailbox) return res.status(404).json({ error: '未找到' });
  sess.mailbox = sess.mailbox.filter(m => m.id !== req.params.mailId);
  saveSessionsToDisk();
  res.json({ success: true, mailbox: sess.mailbox });
});

app.get(['/models', '/v1/models'], (req, res) => {
  const models = MODEL_NAME.split(',').map(m => m.trim()).filter(Boolean);
  const data = models.map(id => ({
    id: id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'gugu-bot'
  }));
  res.json({ object: 'list', data });
});

app.get(['/chat/completions', '/v1/chat/completions'], (req, res) => {
  res.status(200).json({ status: 'ok', message: 'gugu-bot endpoint ready.' });
});

app.post(['/chat/completions', '/v1/chat/completions'], authenticate, async (req, res) => {
  const { messages, stream = false, model = MODEL_NAME } = req.body || {};
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: { message: 'messages 数组不能为空' } });
  }

  const { sessionId, ip, userAgent, firstSnippet } = getSessionFingerprint(req, messages);
  const clientName = parseClientName(userAgent);
  const isStream = Boolean(stream);

  let currentSystemPrompt = '';
  for (const m of messages) {
    if (m.role === 'system') {
      if (typeof m.content === 'string') currentSystemPrompt = m.content.trim();
      else if (Array.isArray(m.content)) {
        currentSystemPrompt = m.content.map(p => p.text || '').join('\n').trim();
      }
      break;
    }
  }

  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      id: sessionId,
      firstSnippet: firstSnippet || '',
      alias: `未登记 (${maskIp(ip)})`,
      isRegistered: false,
      clientIp: ip,
      clientName: clientName,
      systemPrompt: currentSystemPrompt,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      history: [],
      mailbox: [],
      pendingRequestId: null,
      pendingStartTime: null
    };
    sessions.set(sessionId, session);
  } else {
    session.clientIp = ip;
    session.clientName = clientName;
    if (currentSystemPrompt) session.systemPrompt = currentSystemPrompt;
  }

  const userImages = extractImagesFromMessages(messages);
  let lastUserMsg = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      const content = messages[i].content;
      if (typeof content === 'string') {
        lastUserMsg = content.replace(/!\[.*?\]\([^\\)]+\)/g, '').trim();
      } else if (Array.isArray(content)) {
        const textParts = content.filter(p => p.type === 'text').map(p => p.text);
        lastUserMsg = textParts.join('\n').trim();
      }
      if (lastUserMsg || userImages.length > 0) break;
    }
  }

  session.lastActiveAt = Date.now();
  session.history.push({
    role: 'user',
    content: lastUserMsg,
    images: userImages,
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false })
  });
  saveSessionsToDisk();

  if (!session.isRegistered) {
    const registeredName = parseRegistrationName(lastUserMsg);

    if (registeredName) {
      session.isRegistered = true;
      session.alias = registeredName;

      const successText = `🎉 **【身份验证通过】**\n\n你好，**${registeredName}**！你的专属信道已建立。\n从现在开始，你可以向我提问任何问题了，我会竭诚为你解答！✨`;

      session.history.push({
        role: 'assistant',
        content: successText,
        time: new Date().toLocaleTimeString('zh-CN', { hour12: false })
      });
      saveSessionsToDisk();

      if (bot && TELEGRAM_ADMIN_CHAT_ID) {
        bot.telegram.sendMessage(TELEGRAM_ADMIN_CHAT_ID, `🔔 *新朋友登记通知*：\n\n好友【*${registeredName}*】已通过身份认证，接入了 gugu-bot！`, { parse_mode: 'Markdown' }).catch(() => {});
      }

      return sendDirectSystemReply(res, isStream, model, successText);
    } else {
      const promptText = `🤖 **【gugu-bot 接入认证提醒】**\n\n检测到您是新用户接入！为了给您提供专属个性化解答，请先完成【身份登记】。\n\n👉 **请直接回复以下格式完成登记：**\n\`我是: 你的名字\`（例如：\`我是: 小明\` 或 \`名字: 张三\`）\n\n完成登记后，gugu-bot 将正式为您开启智能交互信道！`;

      session.history.push({
        role: 'assistant',
        content: promptText,
        time: new Date().toLocaleTimeString('zh-CN', { hour12: false })
      });
      saveSessionsToDisk();

      return sendDirectSystemReply(res, isStream, model, promptText);
    }
  }

  const requestId = crypto.randomUUID();
  session.pendingRequestId = requestId;
  session.pendingStartTime = Date.now();

  let heartbeatTimer = null;
  const completionId = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;

  if (isStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': keep-alive\n\n');
    heartbeatTimer = setInterval(() => {
      try { res.write(': keep-alive\n\n'); } catch (e) { clearInterval(heartbeatTimer); }
    }, 3000);
  }

  if (session.mailbox && session.mailbox.length > 0) {
    const letters = [...session.mailbox];
    session.mailbox = [];
    saveSessionsToDisk();
    const greetingText = letters.map(l => `💌 [gugu-bot 曾给你留了悄悄话 (${l.createdAt})]:\n"${l.content}"`).join('\n\n') + '\n\n' + '--------------------------------\n';
    
    if (isStream) {
      const chunkRole = {
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{ index: 0, delta: { role: 'assistant', content: greetingText }, finish_reason: null }]
      };
      res.write(`data: ${JSON.stringify(chunkRole)}\n\n`);
    }
  }

  const timer = setTimeout(() => {
    if (pendingRequests.has(requestId)) {
      console.log(`[超时] 会话 ${session.alias} 的请求 ${requestId} 超时`);
      resolveChatRequest(requestId, TIMEOUT_FALLBACK_TEXT, false);
    }
  }, REPLY_TIMEOUT_SECONDS * 1000);

  pendingRequests.set(requestId, {
    sessionId,
    res,
    stream: isStream,
    model,
    completionId,
    timer,
    heartbeatTimer,
    userMessage: lastUserMsg,
    images: userImages,
    hasSentRole: Boolean(session.mailbox && session.mailbox.length > 0),
    totalSentCount: session.mailbox && session.mailbox.length > 0 ? 1 : 0,
    isResolved: false
  });

  notifyTelegram(requestId, session, lastUserMsg, userImages);

  res.on('close', () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  });
});

app.get(['/admin', '/console'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/', (req, res) => {
  res.send(`
    <h2>🕊️ gugu-bot 专属多朋友客服系统</h2>
    <p>OpenAI 兼容 Base URL: <code>${req.protocol}://${req.get('host')}/v1</code></p>
    <p><b>👉 请使用手机浏览器进入专属工作台:</b> <a href="/admin" style="font-size:18px;font-weight:bold;">进入 /admin</a></p>
  `);
});

app.listen(PORT, () => {
  console.log(`🕊️ gugu-bot (Dedicated Chat Rooms & 10min Timeout) 启动完成！端口 ${PORT}`);
});
