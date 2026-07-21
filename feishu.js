const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

// 初始化 Supabase 客户端
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

module.exports = async (req, res) => {
  // 只接收 POST 请求
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  const body = req.body || {};

  // 1. 响应飞书开放平台的 URL 校验事件 (第一次配置 Webhook 时触发)
  if (body.type === 'url_verification') {
    return res.status(200).json({ challenge: body.challenge });
  }

  // 2. 处理接收到的消息事件
  const event = body.event;
  if (event && event.message && event.message.msg_type === 'text') {
    const chatId = event.message.chat_id;
    const userMessage = JSON.parse(event.message.content).text;

    // -------------------------------------------------------------
    // 【核心机制】：立刻开启后台异步任务（不 await），处理 Agent 推理
    // -------------------------------------------------------------
    processAgentAsync(chatId, userMessage).catch(err => {
      console.error('Agent 异步运行错误:', err);
    });

    // -------------------------------------------------------------
    // 【强行 100ms 秒回】：立刻向飞书返回 200 OK，防止飞书认为 3s 超时
    // -------------------------------------------------------------
    return res.status(200).json({ code: 0, msg: "success" });
  }

  return res.status(200).json({ code: 0, msg: "ignored" });
};

// 后台异步推理与消息回传逻辑
async function processAgentAsync(chatId, userMessage) {
  try {
    // 1. 读取 Supabase 里的对话上下文记忆 (最近 6 条)
    const { data: history } = await supabase
      .from('chat_memories')
      .select('role, content')
      .eq('chat_id', chatId)
      .order('created_at', { ascending: false })
      .limit(6);

    const messages = [];
    if (history) {
      // 恢复时间顺序
      history.reverse().forEach(item => {
        messages.push({ role: item.role, content: item.content });
      });
    }
    messages.push({ role: 'user', content: userMessage });

    // 2. 将用户新消息存入 Supabase 记忆库
    await supabase.from('chat_memories').insert([
      { chat_id: chatId, role: 'user', content: userMessage }
    ]);

    // 3. 调用大模型 API (以 DeepSeek / OpenAI 为例)
    const llmResponse = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.LLM_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: '你是由 Hermes 架构驱动的智能团队助手。' },
          ...messages
        ]
      })
    }).then(r => r.json());

    const aiReply = llmResponse.choices?.[0]?.message?.content || "抱歉，思考过程中遇到了点小问题。";

    // 4. 将 AI 思考结果存入 Supabase 记忆库
    await supabase.from('chat_memories').insert([
      { chat_id: chatId, role: 'assistant', content: aiReply }
    ]);

    // 5. 调用飞书 Open API 主动回复消息给用户
    await sendFeishuMessage(chatId, aiReply);
  } catch (error) {
    console.error('processAgentAsync 报错:', error);
  }
}

// 辅助函数：获取飞书 tenant_access_token 并发送消息
async function sendFeishuMessage(chatId, text) {
  // 获取 token
  const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: process.env.FEISHU_APP_ID,
      app_secret: process.env.FEISHU_APP_SECRET
    })
  }).then(r => r.json());

  const accessToken = tokenRes.tenant_access_token;

  // 发送消息
  await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text: text })
    })
  });
}
