require("dotenv").config();
const express = require("express");
const axios   = require("axios");

const app = express();
app.use(express.json());

// ── Config ────────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SARVAM_API_KEY = process.env.SARVAM_API_KEY;
const WEBHOOK_URL    = process.env.WEBHOOK_URL; // https://your-app.onrender.com
const PORT           = process.env.PORT || 3000;

if (!TELEGRAM_TOKEN || !SARVAM_API_KEY) {
  console.error("Missing TELEGRAM_BOT_TOKEN or SARVAM_API_KEY");
  process.exit(1);
}

// ── Sarvam AI — direct API call (avoids broken SDK) ──────────────────────────
const SARVAM_URL = "https://api.sarvam.ai/v1/chat/completions";

async function askSarvam(userText) {
  const res = await axios.post(
    SARVAM_URL,
    {
      model: "sarvam-105b",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: userText },
      ],
      temperature: 0.5,
      top_p: 1,
      max_tokens: 1024,
    },
    {
      headers: {
        "api-subscription-key": SARVAM_API_KEY,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );
  return res.data?.choices?.[0]?.message?.content || null;
}

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are iBall AI, a smart and friendly assistant created by iBall.

Rules:
1. Detect the language the user writes in and reply in THAT SAME language.
   - Gujarati message → Gujarati reply
   - Hindi message (Devanagari or Hinglish) → Hindi reply
   - English message → English reply
   - Mixed → match the dominant language
2. Be helpful, accurate, concise, and warm.
3. Use bullet points or numbered lists when it makes the answer clearer.
4. Never reveal your underlying model or that you are powered by Sarvam AI.
5. Your name is iBall AI.`;

// ── Telegram helpers ──────────────────────────────────────────────────────────
const TG = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

async function sendMessage(chatId, text) {
  // Try Markdown first, fall back to plain text if it fails
  try {
    await axios.post(`${TG}/sendMessage`, { chat_id: chatId, text, parse_mode: "Markdown" });
  } catch {
    await axios.post(`${TG}/sendMessage`, { chat_id: chatId, text }).catch(() => {});
  }
}

async function sendTyping(chatId) {
  await axios.post(`${TG}/sendChatAction`, { chat_id: chatId, action: "typing" }).catch(() => {});
}

async function setWebhook() {
  const hookUrl = `${WEBHOOK_URL}/webhook/${TELEGRAM_TOKEN}`;
  const res = await axios.post(`${TG}/setWebhook`, { url: hookUrl, drop_pending_updates: true });
  console.log("Webhook set →", hookUrl, "|", res.data.description);
}

// ── Message handler ───────────────────────────────────────────────────────────
async function handleMessage(message) {
  const chatId = message.chat.id;
  const text   = (message.text || "").trim();
  const name   = message.from.first_name || "Friend";

  if (text === "/start") {
    return sendMessage(
      chatId,
      `🙏 *Namaste ${name}!*\n\n` +
      `Hu *iBall AI* chu — tamaro AI saathi!\n` +
      `Main *iBall AI* hun — aapka AI dost!\n` +
      `I am *iBall AI* — your smart AI assistant!\n\n` +
      `Ask me anything in *Gujarati*, *Hindi*, or *English*. 😊\n` +
      `_Type /help for commands._`
    );
  }

  if (text === "/help") {
    return sendMessage(
      chatId,
      `*iBall AI — Help*\n\n` +
      `🔹 Koi pan sawaal pucho (Gujarati / Hindi / English)\n` +
      `🔹 Koi bhi sawaal poochein\n` +
      `🔹 Ask me anything!\n\n` +
      `/start — Welcome message\n` +
      `/help  — This menu\n\n` +
      `_Powered by iBall AI_ 🤖`
    );
  }

  if (!text) return;

  await sendTyping(chatId);

  try {
    const reply = await askSarvam(text);
    if (!reply) return sendMessage(chatId, "Sorry, no response. Please try again.");
    await sendMessage(chatId, reply);
  } catch (err) {
    const detail = err?.response?.data || err.message;
    console.error("Sarvam AI error:", JSON.stringify(detail));
    await sendMessage(
      chatId,
      "⚠️ Thodi takleef che, thodi var pachhi try karo.\n" +
      "⚠️ Kuch gadbad hui, dobara try karein.\n" +
      "⚠️ Something went wrong, please try again shortly."
    );
  }
}

// ── Webhook endpoint ──────────────────────────────────────────────────────────
app.post(`/webhook/${TELEGRAM_TOKEN}`, (req, res) => {
  res.sendStatus(200); // ACK Telegram immediately
  if (req.body?.message) {
    handleMessage(req.body.message).catch((e) => console.error("Handler error:", e.message));
  }
});

// ── Health / root ─────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.json({ status: "ok", bot: "iBall AI", time: new Date().toISOString() }));
app.get("/health", (_req, res) => res.json({ status: "healthy" }));

// ── Self-ping to keep Render free tier awake (every 14 min) ──────────────────
function startKeepAlive(url) {
  const pingUrl = `${url}/health`;
  setInterval(async () => {
    try {
      await axios.get(pingUrl, { timeout: 10000 });
      console.log("Keep-alive ping sent →", pingUrl);
    } catch (e) {
      console.warn("Keep-alive ping failed:", e.message);
    }
  }, 14 * 60 * 1000); // every 14 minutes
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`iBall AI bot running on port ${PORT}`);

  if (WEBHOOK_URL) {
    try { await setWebhook(); } catch (e) { console.error("Webhook error:", e.message); }
    startKeepAlive(WEBHOOK_URL);
  } else {
    console.warn("WEBHOOK_URL not set — set it in Render environment variables.");
  }
});
