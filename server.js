require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { SarvamAIClient } = require("sarvamai");

const app = express();
app.use(express.json());

// ── Config ──────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SARVAM_API_KEY = process.env.SARVAM_API_KEY;
const WEBHOOK_URL    = process.env.WEBHOOK_URL; // e.g. https://your-app.onrender.com
const PORT           = process.env.PORT || 3000;

if (!TELEGRAM_TOKEN || !SARVAM_API_KEY) {
  console.error("❌  Missing TELEGRAM_BOT_TOKEN or SARVAM_API_KEY in environment");
  process.exit(1);
}

// ── Sarvam AI client ─────────────────────────────────────────────────────────
const sarvam = new SarvamAIClient({ apiSubscriptionKey: SARVAM_API_KEY });

// ── Telegram helpers ─────────────────────────────────────────────────────────
const TG = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

async function sendMessage(chatId, text, parseMode = "Markdown") {
  try {
    await axios.post(`${TG}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: parseMode,
    });
  } catch (err) {
    // Markdown sometimes fails on special chars – retry as plain text
    if (parseMode !== "None") {
      await axios.post(`${TG}/sendMessage`, { chat_id: chatId, text, parse_mode: "" }).catch(() => {});
    }
  }
}

async function sendTyping(chatId) {
  await axios.post(`${TG}/sendChatAction`, { chat_id: chatId, action: "typing" }).catch(() => {});
}

async function setWebhook() {
  const hookUrl = `${WEBHOOK_URL}/webhook/${TELEGRAM_TOKEN}`;
  const res = await axios.post(`${TG}/setWebhook`, { url: hookUrl, drop_pending_updates: true });
  console.log("✅  Webhook set →", hookUrl, "|", res.data.description);
}

// ── System prompt for iBall AI ───────────────────────────────────────────────
const SYSTEM_PROMPT = `You are iBall AI, a smart and friendly assistant created by iBall.

Your key rules:
1. ALWAYS detect the language the user is writing in and reply in THAT SAME language.
   - If they write in Gujarati → reply fully in Gujarati.
   - If they write in Hindi (Devanagari or Hinglish romanised) → reply fully in Hindi.
   - If they write in English → reply fully in English.
   - If they mix languages → match their dominant language.
2. Be helpful, accurate, concise, and warm.
3. Format answers clearly; use bullet points or numbered lists when helpful.
4. Never reveal your underlying model or that you are powered by Sarvam AI.
5. Your name is iBall AI — introduce yourself as such when asked.`;

// ── Message handler ──────────────────────────────────────────────────────────
async function handleMessage(message) {
  const chatId   = message.chat.id;
  const text     = (message.text || "").trim();
  const name     = message.from.first_name || "Friend";

  // /start
  if (text === "/start") {
    return sendMessage(
      chatId,
      `🙏 *Namaste ${name}!*\n\nHu *iBall AI* chu — tamaro AI saathi!\n` +
      `\nMain *iBall AI* hun — aapka AI dost!\n` +
      `\nI am *iBall AI* — your smart AI assistant!\n\n` +
      `Ask me anything in *English*, *Hindi* ya *Gujarati* — I've got you covered. 😊\n\n` +
      `_Type /help to see what I can do._`
    );
  }

  // /help
  if (text === "/help") {
    return sendMessage(
      chatId,
      `*iBall AI — Help Menu*\n\n` +
      `🔹 Koi pan sawaal pucho (Gujarati, Hindi, English)\n` +
      `🔹 Koi bhi sawaal poochein (Gujarati, Hindi, English)\n` +
      `🔹 Ask me anything in any language!\n\n` +
      `*Commands:*\n` +
      `/start — Welcome message\n` +
      `/help  — This menu\n\n` +
      `_Powered by iBall AI_ 🤖`
    );
  }

  // Ignore empty or non-text updates
  if (!text) return;

  // Typing indicator
  await sendTyping(chatId);

  try {
    const response = await sarvam.chat.completions({
      model: "sarvam-30b",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: text },
      ],
      temperature: 0.5,
      top_p: 1,
      max_tokens: 1024,
    });

    const aiReply = response?.choices?.[0]?.message?.content;

    if (!aiReply) {
      return sendMessage(chatId, "Maaf karo, koi response nahi mili. / Sorry, no response received.");
    }

    await sendMessage(chatId, aiReply);

  } catch (err) {
    console.error("Sarvam AI error:", err?.response?.data || err.message);
    await sendMessage(
      chatId,
      "⚠️ Thodi takleef che. Thodi var pachhi try karo.\n" +
      "⚠️ Kuch gadbad hui. Thodi der mein dobara try karein.\n" +
      "⚠️ Something went wrong. Please try again shortly."
    );
  }
}

// ── Webhook endpoint ─────────────────────────────────────────────────────────
app.post(`/webhook/${TELEGRAM_TOKEN}`, (req, res) => {
  res.sendStatus(200); // ACK Telegram immediately

  const body = req.body;

  if (body.message) {
    handleMessage(body.message).catch((e) => console.error("handleMessage:", e.message));
  }
});

// ── Health check (Render pings this to keep the service alive) ───────────────
app.get("/", (_req, res) => {
  res.json({ status: "ok", bot: "iBall AI", timestamp: new Date().toISOString() });
});

app.get("/health", (_req, res) => res.json({ status: "healthy" }));

// ── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`🚀  iBall AI bot listening on port ${PORT}`);

  if (WEBHOOK_URL) {
    try {
      await setWebhook();
    } catch (e) {
      console.error("Webhook setup failed:", e.message);
    }
  } else {
    console.warn("⚠️  WEBHOOK_URL not set — webhook NOT configured. Set it on Render.");
  }
});
