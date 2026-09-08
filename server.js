import express from 'express';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { Telegraf } from 'telegraf';

dotenv.config();

const PORT = process.env.PORT || 3000;
const MODEL_NAME = process.env.MODEL_NAME || 'gugu-bot';
const API_KEY = process.env.API_KEY || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '';

// 延长默认超时时间到 10 分钟（600 秒），给真人留足充裕的打字和构思时间！
const REPLY_TIMEOUT_SECONDS = parseInt(process.env.REPLY_TIMEOUT_SECONDS || '600', 10);
const TIMEOUT_FALLBACK_TEXT = process.env.TIMEOUT_FALLBACK_TEXT || '（gugu-bot 算力节点过热，思考超时啦，请再问一次试试～）';

const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

/**
 * session 存储:
 * sessionId -> {
 *   id,
 *   alias,
 *   isRegistered,
 *   clientIp,
 *   clientName,
 *   createdAt,
 *   lastActiveAt,
 *   history: [],
 *   mailbox: [],
 *   pendingRequestId,
 *   pendingStartTime
 * }
 */
const sessions = new Map();
const pendingRequests = new Map();
const tgMessageToRequestId = new Map();

function getSessionFingerprint(req, messages) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || '127.0.0.1';
  const customUser = req.body.user || '';
  
  let firstSnippet = '';
  for (const m of messages) {
    if (m.role === 'user') {
      firstSnippet = typeof m.content === 'string' ? m.content.slice(0, 30) : 'multimodal';
      break;
    }
  }

  const hash = crypto.createHash('md5').update(`${ip}_${customUser}_${firstSnippet}`).digest('hex').slice(0, 8);
  return {
    sessionId: `session_${hash}`,
    ip,
    userAgent: req.headers['user-agent'] || 'OpenAI-Client'
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

// Telegram 机器人
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
  if (images.length > 0) text += `🖼️ *附带图片*: ${images.length} 张\n`;
  text += `💬 *提问*: *${userMessage || '（仅发送图片）'}*\n\n`;
  text += `👉 *操作*: 长按回复，或在网页端打开【${sessionName}】的专属对话框回复！`;

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

app.get('/api/sessions', (req, res) => {
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
      messageCount: s.history.length
    };
  }).sort((a, b) => {
    if (a.isPending && !b.isPending) return -1;
    if (!a.isPending && b.isPending) return 1;
    return b.lastActiveAt - a.lastActiveAt;
  });

  res.json({ total: list.length, sessions: list, timeoutSeconds: REPLY_TIMEOUT_SECONDS });
});

app.get('/api/session/:id', (req, res) => {
  const sess = sessions.get(req.params.id);
  if (!sess) return res.status(404).json({ error: '会话不存在' });
  const isPending = Boolean(sess.pendingRequestId && pendingRequests.has(sess.pendingRequestId));
  res.json({
    ...sess,
    isPending,
    pendingRequestId: isPending ? sess.pendingRequestId : null,
    pendingStartTime: sess.pendingStartTime || null,
    mailbox: sess.mailbox || [],
    timeoutSeconds: REPLY_TIMEOUT_SECONDS
  });
});

app.post('/api/session/:id/alias', (req, res) => {
  const { alias } = req.body;
  const sess = sessions.get(req.params.id);
  if (!sess) return res.status(404).json({ error: '会话不存在' });
  sess.alias = (alias || '').trim() || `朋友 (${maskIp(sess.clientIp)})`;
  sess.isRegistered = true;
  res.json({ success: true, alias: sess.alias });
});

app.post('/api/reply', (req, res) => {
  const { requestId, content, keepAlive = false } = req.body;
  if (!requestId || !content) return res.status(400).json({ error: '参数缺失' });
  if (!pendingRequests.has(requestId)) return res.status(404).json({ error: '该提问已过期或已被回复' });
  resolveChatRequest(requestId, content, Boolean(keepAlive));
  res.json({ success: true, keepAlive: Boolean(keepAlive) });
});

app.post('/api/finish', (req, res) => {
  const { requestId } = req.body;
  if (requestId && pendingRequests.has(requestId)) {
    finishStream(requestId);
  }
  res.json({ success: true });
});

app.post('/api/session/:id/mailbox', (req, res) => {
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

  res.json({ success: true, mailbox: sess.mailbox });
});

app.delete('/api/session/:id/mailbox/:mailId', (req, res) => {
  const sess = sessions.get(req.params.id);
  if (!sess || !sess.mailbox) return res.status(404).json({ error: '未找到' });
  sess.mailbox = sess.mailbox.filter(m => m.id !== req.params.mailId);
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

// 对话入口
app.post(['/chat/completions', '/v1/chat/completions'], authenticate, async (req, res) => {
  const { messages, stream = false, model = MODEL_NAME } = req.body || {};
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: { message: 'messages 数组不能为空' } });
  }

  const { sessionId, ip, userAgent } = getSessionFingerprint(req, messages);
  const clientName = parseClientName(userAgent);
  const isStream = Boolean(stream);

  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      id: sessionId,
      alias: `未登记 (${maskIp(ip)})`,
      isRegistered: false,
      clientIp: ip,
      clientName: clientName,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      history: [],
      mailbox: [],
      pendingRequestId: null,
      pendingStartTime: null
    };
    sessions.set(sessionId, session);
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

  // 实名认证拦截
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

      return sendDirectSystemReply(res, isStream, model, promptText);
    }
  }

  // 已登记用户接入
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
  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>gugu-bot 专属工作台</title>
  <style>
    :root {
      --primary: #6366f1;
      --primary-hover: #4f46e5;
      --bg: #0b1120;
      --panel-bg: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --bubble-user: #1e293b;
      --bubble-ai: #4f46e5;
      --danger: #ef4444;
      --success: #10b981;
      --warning: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); height: 100dvh; display: flex; flex-direction: column; overflow: hidden; }

    header { background: var(--panel-bg); border-bottom: 1px solid var(--border); height: 54px; padding: 0 16px; display: flex; justify-content: space-between; align-items: center; z-index: 20; flex-shrink: 0; }
    .brand { font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 8px; color: #fff; }
    .badge-count { background: var(--danger); color: #fff; font-size: 11px; padding: 2px 7px; border-radius: 10px; font-weight: 700; }
    .btn-audio { background: #334155; border: none; color: #cbd5e1; font-size: 12px; padding: 5px 9px; border-radius: 8px; cursor: pointer; }

    .views-wrapper { flex: 1; position: relative; overflow: hidden; display: flex; width: 100%; height: 100%; }

    .view-list { width: 100%; height: 100%; display: flex; flex-direction: column; overflow-y: auto; background: var(--bg); position: absolute; top:0; left:0; transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1); z-index: 5; }
    .view-list.slide-left { transform: translateX(-100%); }

    .chat-card {
      padding: 14px 16px;
      display: flex;
      gap: 12px;
      align-items: center;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      background: rgba(30, 41, 59, 0.3);
      cursor: pointer;
      transition: background 0.15s;
    }
    .chat-card:active { background: rgba(30, 41, 59, 0.8); }

    .avatar {
      width: 48px;
      height: 48px;
      border-radius: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
      font-weight: 700;
      color: #fff;
      flex-shrink: 0;
      position: relative;
    }
    .avatar-dot {
      width: 12px;
      height: 12px;
      background: var(--danger);
      border: 2px solid var(--bg);
      border-radius: 50%;
      position: absolute;
      top: -2px;
      right: -2px;
      animation: pulse 1.5s infinite;
    }

    .card-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .card-top { display: flex; justify-content: space-between; align-items: center; }
    .card-name { font-size: 15px; font-weight: 600; color: #f1f5f9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .card-time { font-size: 11px; color: var(--text-muted); }
    .card-bottom { display: flex; justify-content: space-between; align-items: center; font-size: 13px; color: var(--text-muted); }
    .card-snippet { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 75%; }
    .badge-status-tag { font-size: 10px; padding: 2px 6px; border-radius: 4px; font-weight: 600; }
    .tag-waiting { background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4); }
    .tag-idle { background: rgba(16, 185, 129, 0.15); color: #34d399; }

    .view-chat { width: 100%; height: 100%; display: flex; flex-direction: column; background: var(--bg); position: absolute; top:0; left:100%; transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1); z-index: 10; }
    .view-chat.active { transform: translateX(-100%); }

    .room-header {
      background: var(--panel-bg);
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }
    .btn-back {
      background: none;
      border: none;
      color: #cbd5e1;
      font-size: 15px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      padding: 6px 4px;
    }
    .room-title-box { text-align: center; }
    .room-title { font-size: 15px; font-weight: 700; color: #fff; }
    .room-sub { font-size: 11px; color: var(--text-muted); }
    .btn-room-rename { background: #334155; border: none; color: #93c5fd; font-size: 12px; padding: 5px 10px; border-radius: 6px; cursor: pointer; }

    .waiting-bar {
      background: linear-gradient(90deg, #b91c1c, #991b1b);
      color: #fff;
      padding: 8px 16px;
      font-size: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-weight: 500;
      box-shadow: 0 2px 6px rgba(0,0,0,0.3);
    }
    .waiting-timer { font-family: monospace; font-weight: 700; font-size: 13px; background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 4px; }

    .mailbox-notice {
      background: rgba(245, 158, 11, 0.15);
      border-bottom: 1px solid rgba(245, 158, 11, 0.3);
      padding: 6px 16px;
      font-size: 12px;
      color: #fcd34d;
      display: flex;
      justify-content: space-between;
    }

    .room-messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 14px; }
    
    .msg-group { display: flex; flex-direction: column; max-width: 85%; }
    .msg-group.user { align-self: flex-start; }
    .msg-group.assistant { align-self: flex-end; }

    .msg-sender { font-size: 11px; color: var(--text-muted); margin-bottom: 3px; padding: 0 4px; }
    .msg-group.assistant .msg-sender { text-align: right; }

    .msg-bubble {
      padding: 10px 14px;
      border-radius: 14px;
      font-size: 14.5px;
      line-height: 1.45;
      word-break: break-word;
      box-shadow: 0 2px 4px rgba(0,0,0,0.15);
    }
    .msg-group.user .msg-bubble { background: var(--bubble-user); border: 1px solid rgba(255,255,255,0.06); border-bottom-left-radius: 3px; }
    .msg-group.assistant .msg-bubble { background: var(--bubble-ai); border-bottom-right-radius: 3px; color: #fff; }

    .msg-images { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
    .msg-images img { max-width: 220px; max-height: 200px; border-radius: 8px; object-fit: cover; cursor: pointer; }

    .quick-replies { display: flex; gap: 6px; overflow-x: auto; padding: 6px 12px; background: #111827; border-top: 1px solid var(--border); scrollbar-width: none; }
    .quick-replies::-webkit-scrollbar { display: none; }
    .quick-chip { background: #1f2937; border: 1px solid #374151; border-radius: 14px; padding: 4px 10px; font-size: 12px; color: #cbd5e1; white-space: nowrap; cursor: pointer; }
    .quick-chip:active { background: var(--primary); color: #fff; }

    .room-footer { padding: 8px 12px 14px; background: var(--panel-bg); border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; }
    .input-box { width: 100%; background: #0f172a; border: 1px solid var(--border); border-radius: 12px; padding: 10px 12px; color: #fff; font-size: 15px; max-height: 100px; min-height: 44px; outline: none; resize: none; font-family: inherit; }
    .input-box:focus { border-color: var(--primary); }

    .btn-row { display: flex; gap: 8px; align-items: center; }
    
    .btn-action {
      flex: 1;
      height: 42px;
      border: none;
      border-radius: 10px;
      font-size: 13.5px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
    }
    .btn-primary { background: var(--primary); color: #fff; }
    .btn-primary:active { background: var(--primary-hover); transform: scale(0.97); }

    .btn-keep { background: #059669; color: #fff; }
    .btn-keep:active { background: #047857; transform: scale(0.97); }

    .btn-offline { background: #d97706; color: #fff; }
    .btn-finish { background: #475569; color: #cbd5e1; max-width: 80px; }

    @keyframes pulse {
      0% { transform: scale(0.9); opacity: 0.8; }
      50% { transform: scale(1.3); opacity: 1; box-shadow: 0 0 8px var(--danger); }
      100% { transform: scale(0.9); opacity: 0.8; }
    }

    .empty-list { margin: auto; text-align: center; color: var(--text-muted); font-size: 14px; padding: 40px 20px; }
  </style>
</head>
<body>

  <header>
    <div class="brand">
      <span>🕊️ gugu-bot 客服控制台</span>
      <span class="badge-count" id="headerPendingCount" style="display:none;">0</span>
    </div>
    <button class="btn-audio" id="audioToggle" onclick="toggleAudio()">🔔 声音: 开</button>
  </header>

  <div class="views-wrapper">
    
    <div class="view-list" id="viewList">
      <div id="sessionsListContainer">
        <div class="empty-list">正在连接服务器...</div>
      </div>
    </div>

    <div class="view-chat" id="viewChat">
      <div class="room-header">
        <button class="btn-back" onclick="closeChatRoom()">
          <span>‹ 返回列表</span>
        </button>
        <div class="room-title-box">
          <div class="room-title" id="roomTitle">好友专属对话</div>
          <div class="room-sub" id="roomSub">客户端信息</div>
        </div>
        <button class="btn-room-rename" onclick="renameRoomFriend()">改备注</button>
      </div>

      <div id="waitingBar" class="waiting-bar" style="display:none;">
        <span>⏳ 朋友正在苦苦等待回复中</span>
        <span class="waiting-timer" id="countdownTimer">10:00</span>
      </div>

      <div id="roomMailboxBanner" class="mailbox-notice" style="display:none;">
        <span>📬 已存入 <b id="roomMailboxCount">0</b> 条离线悄悄话</span>
        <span>下次露头即弹</span>
      </div>

      <div class="room-messages" id="roomMessages">
        <div style="margin:auto; color:var(--text-muted);">加载中...</div>
      </div>

      <div class="quick-replies">
        <div class="quick-chip" onclick="fillQuick('收到，本大模型正在认真思考中...')">🤔 思考中</div>
        <div class="quick-chip" onclick="fillQuick('哈哈哈哈哈哈，有意思！')">😂 哈哈</div>
        <div class="quick-chip" onclick="fillQuick('你先别急，听我继续给你说：\\n')">🗣️ 听我说</div>
        <div class="quick-chip" onclick="fillQuick('稍等一下哈，我手头有点事，马上给你解答！')">⏳ 稍等</div>
        <div class="quick-chip" onclick="fillQuick('（gugu-bot 正在努力散热降温中...）')">❄️ 散热中</div>
      </div>

      <div class="room-footer">
        <textarea id="replyInput" class="input-box" rows="1" placeholder="输入回复内容..."></textarea>
        <div class="btn-row" id="roomBtnRow"></div>
      </div>
    </div>

  </div>

  <script>
    let activeSessionId = null;
    let activeRequestId = null;
    let sessionsCache = [];
    let timeoutSeconds = 600;
    let countdownInterval = null;
    let audioEnabled = true;
    let audioCtx = null;

    const avatarColors = [
      'linear-gradient(135deg, #6366f1, #4f46e5)',
      'linear-gradient(135deg, #ec4899, #be185d)',
      'linear-gradient(135deg, #10b981, #047857)',
      'linear-gradient(135deg, #f59e0b, #b45309)',
      'linear-gradient(135deg, #8b5cf6, #6d28d9)',
      'linear-gradient(135deg, #06b6d4, #0e7490)'
    ];

    function getAvatarColor(name) {
      let code = 0;
      for (let i = 0; i < name.length; i++) code += name.charCodeAt(i);
      return avatarColors[code % avatarColors.length];
    }

    function playDing() {
      if (!audioEnabled) return;
      try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(1320, audioCtx.currentTime + 0.15);
        gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.4);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.4);
      } catch (e) {}
    }

    function toggleAudio() {
      audioEnabled = !audioEnabled;
      document.getElementById('audioToggle').innerText = audioEnabled ? '🔔 声音: 开' : '🔕 声音: 关';
    }

    async function syncSessions() {
      try {
        const res = await fetch('/api/sessions');
        const data = await res.json();
        timeoutSeconds = data.timeoutSeconds || 600;

        const oldPending = sessionsCache.filter(s => s.isPending).length;
        sessionsCache = data.sessions;
        const newPending = sessionsCache.filter(s => s.isPending).length;

        const badge = document.getElementById('headerPendingCount');
        if (newPending > 0) {
          badge.style.display = 'inline-block';
          badge.innerText = newPending;
        } else {
          badge.style.display = 'none';
        }

        if (newPending > oldPending) playDing();

        renderSessionsList();

        if (activeSessionId) {
          loadRoomData(activeSessionId, false);
        }
      } catch (err) {
        console.error('同步失败', err);
      }
    }

    function renderSessionsList() {
      const container = document.getElementById('sessionsListContainer');
      if (sessionsCache.length === 0) {
        container.innerHTML = '<div class="empty-list">目前还没有朋友发来消息哦～<br/><span style="font-size:12px;opacity:0.7;">把接口发给朋友，对方发第一句话时会提醒TA登记姓名！</span></div>';
        return;
      }

      container.innerHTML = sessionsCache.map(s => {
        const initial = s.alias.replace(/^我是[:：\s]*/, '').slice(0, 1) || '友';
        const color = getAvatarColor(s.alias);
        return \`
          <div class="chat-card" onclick="openChatRoom('\${s.id}')">
            <div class="avatar" style="background: \${color};">
              \${initial}
              \${s.isPending ? '<div class="avatar-dot"></div>' : ''}
            </div>
            <div class="card-main">
              <div class="card-top">
                <div class="card-name">\${s.alias}</div>
                <div class="card-time">\${new Date(s.lastActiveAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div>
              </div>
              <div class="card-bottom">
                <div class="card-snippet">\${s.lastMessage || '无消息'}</div>
                \${s.isPending ? '<span class="badge-status-tag tag-waiting">待回复</span>' : '<span class="badge-status-tag tag-idle">就绪</span>'}
              </div>
            </div>
          </div>
        \`;
      }).join('');
    }

    async function openChatRoom(sessionId) {
      activeSessionId = sessionId;
      document.getElementById('viewList').classList.add('slide-left');
      document.getElementById('viewChat').classList.add('active');
      await loadRoomData(sessionId, true);
    }

    function closeChatRoom() {
      activeSessionId = null;
      if (countdownInterval) clearInterval(countdownInterval);
      document.getElementById('viewList').classList.remove('slide-left');
      document.getElementById('viewChat').classList.remove('active');
    }

    async function loadRoomData(sessionId, shouldScroll) {
      try {
        const res = await fetch(\`/api/session/\${sessionId}\`);
        if (!res.ok) return;
        const s = await res.json();
        activeRequestId = s.pendingRequestId;

        document.getElementById('roomTitle').innerText = s.alias;
        document.getElementById('roomSub').innerText = \`\${s.clientName} · \${s.clientIp}\`;

        const waitingBar = document.getElementById('waitingBar');
        if (s.isPending && s.pendingStartTime) {
          waitingBar.style.display = 'flex';
          startCountdown(s.pendingStartTime, s.timeoutSeconds || 600);
        } else {
          waitingBar.style.display = 'none';
          if (countdownInterval) clearInterval(countdownInterval);
        }

        const mailBanner = document.getElementById('roomMailboxBanner');
        const mailCount = document.getElementById('roomMailboxCount');
        if (s.mailbox && s.mailbox.length > 0) {
          mailBanner.style.display = 'flex';
          mailCount.innerText = s.mailbox.length;
        } else {
          mailBanner.style.display = 'none';
        }

        renderRoomButtons(s);

        const box = document.getElementById('roomMessages');
        if (s.history.length === 0) {
          box.innerHTML = '<div style="margin:auto; color:var(--text-muted);">暂无对话历史</div>';
          return;
        }

        box.innerHTML = s.history.map(m => {
          const isUser = m.role === 'user';
          let imgsHtml = '';
          if (m.images && m.images.length > 0) {
            imgsHtml = '<div class="msg-images">' + m.images.map(img => \`<img src="\${img}" onclick="window.open('\${img}')" />\`).join('') + '</div>';
          }
          return \`
            <div class="msg-group \${isUser ? 'user' : 'assistant'}">
              <div class="msg-sender">\${isUser ? s.alias : 'gugu-bot (我)'} · \${m.time || ''}</div>
              <div class="msg-bubble">
                \${m.content ? m.content.replace(/\\n/g, '<br/>') : ''}
                \${imgsHtml}
              </div>
            </div>
          \`;
        }).join('');

        if (shouldScroll) box.scrollTop = box.scrollHeight;
      } catch (e) {
        console.error(e);
      }
    }

    function startCountdown(startTime, maxSec) {
      if (countdownInterval) clearInterval(countdownInterval);
      function update() {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const remain = Math.max(0, maxSec - elapsed);
        const m = Math.floor(remain / 60).toString().padStart(2, '0');
        const s = (remain % 60).toString().padStart(2, '0');
        const timerEl = document.getElementById('countdownTimer');
        if (timerEl) timerEl.innerText = \`\${m}:\${s}\`;
        if (remain <= 0) clearInterval(countdownInterval);
      }
      update();
      countdownInterval = setInterval(update, 1000);
    }

    function renderRoomButtons(s) {
      const btnRow = document.getElementById('roomBtnRow');
      const input = document.getElementById('replyInput');

      if (s.isPending) {
        input.placeholder = \`给【\${s.alias}】回复或连环主动追发...\`;
        btnRow.innerHTML = \`
          <button class="btn-action btn-keep" onclick="sendReply(true)">
            ⚡ 继续说 (连环追发)
          </button>
          <button class="btn-action btn-primary" onclick="sendReply(false)">
            发送回复 (完成)
          </button>
          <button class="btn-action btn-finish" onclick="finishCurrent()">
            结束
          </button>
        \`;
      } else {
        input.placeholder = \`给【\${s.alias}】留悄悄话 (下次露头秒弹)... \`;
        btnRow.innerHTML = \`
          <button class="btn-action btn-offline" onclick="sendMailbox()">
            💌 存入专属留言箱 (上线自动弹)
          </button>
        \`;
      }
    }

    async function sendReply(keepAlive) {
      const input = document.getElementById('replyInput');
      const text = input.value.trim();
      if (!text) return alert('请输入回复内容！');
      if (!activeRequestId) return alert('该提问已失效或已超时');

      try {
        const res = await fetch('/api/reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: activeRequestId, content: text, keepAlive })
        });
        const data = await res.json();
        if (data.success) {
          input.value = '';
          if (keepAlive) input.placeholder = '已追加发送！连接保持中，可继续打下一句...';
          await loadRoomData(activeSessionId, true);
        } else {
          alert(data.error || '失败');
        }
      } catch (err) {
        alert('发送失败: ' + err.message);
      }
    }

    async function sendMailbox() {
      const input = document.getElementById('replyInput');
      const text = input.value.trim();
      if (!text) return alert('请输入留言内容！');

      try {
        const res = await fetch(\`/api/session/\${activeSessionId}/mailbox\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text })
        });
        const data = await res.json();
        if (data.success) {
          input.value = '';
          alert('💌 悄悄话已存入留言箱！下次TA发消息时会第一优先弹给TA！');
          await loadRoomData(activeSessionId, true);
        } else {
          alert(data.error || '失败');
        }
      } catch (err) {
        alert('错误: ' + err.message);
      }
    }

    async function finishCurrent() {
      if (!activeRequestId) return;
      await fetch('/api/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: activeRequestId })
      });
      await loadRoomData(activeSessionId, true);
    }

    async function renameRoomFriend() {
      if (!activeSessionId) return;
      const current = sessionsCache.find(s => s.id === activeSessionId);
      const newName = prompt('输入朋友备注（如：小明、老李、同桌）：', current ? current.alias : '');
      if (!newName || !newName.trim()) return;

      const res = await fetch(\`/api/session/\${activeSessionId}/alias\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias: newName.trim() })
      });
      const data = await res.json();
      if (data.success) {
        syncSessions();
      }
    }

    function fillQuick(text) {
      const input = document.getElementById('replyInput');
      input.value = text;
      input.focus();
    }

    setInterval(syncSessions, 2000);
    syncSessions();
  </script>
</body>
</html>`);
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
