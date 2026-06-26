require("dotenv").config();
const express  = require("express");
const axios    = require("axios");
const session  = require("express-session");
const multer   = require("multer");
const path     = require("path");

const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore }                 = require("firebase-admin/firestore");
const { getStorage }                   = require("firebase-admin/storage");

// ── Express ────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret           : process.env.SESSION_SECRET || "ibell-secret-2024",
  resave           : false,
  saveUninitialized: false,
  cookie           : { maxAge: 8 * 60 * 60 * 1000 },
}));
app.use(express.static(path.join(__dirname, "public")));

// ── Config ─────────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SARVAM_API_KEY = process.env.SARVAM_API_KEY;
const WEBHOOK_URL    = process.env.WEBHOOK_URL;
const PORT           = process.env.PORT || 3000;
const ADMIN_USER     = "admin";
const ADMIN_PASS     = "123";

if (!TELEGRAM_TOKEN || !SARVAM_API_KEY) {
  console.error("Missing TELEGRAM_BOT_TOKEN or SARVAM_API_KEY"); process.exit(1);
}

// ── Firebase ───────────────────────────────────────────────────────────────────
let db, bucket;
try {
  const svcRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!svcRaw) throw new Error("FIREBASE_SERVICE_ACCOUNT env var not set");
  const fbApp = getApps().length
    ? getApps()[0]
    : initializeApp({
        credential   : cert(JSON.parse(svcRaw)),
        storageBucket: "ibellmobiles-123.firebasestorage.app",
      });
  db     = getFirestore(fbApp, "ibelldatabasefortelegramboat");
  bucket = getStorage(fbApp).bucket();
  console.log("Firebase connected ✓");
} catch (e) {
  console.error("Firebase init error:", e.message);
  console.warn("Admin panel and product features require FIREBASE_SERVICE_ACCOUNT env var.");
}

// ── Multer ─────────────────────────────────────────────────────────────────────
const upload = multer({
  storage   : multer.memoryStorage(),
  limits    : { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, f, cb) =>
    f.mimetype.startsWith("image/") ? cb(null, true) : cb(new Error("Images only")),
});

// ── Helpers ────────────────────────────────────────────────────────────────────
const requireAuth = (req, res, next) =>
  req.session?.isAdmin ? next() : res.status(401).json({ error: "Unauthorized" });

const requireDb = (_req, res, next) =>
  db ? next() : res.status(503).json({ error: "Database not configured. Set FIREBASE_SERVICE_ACCOUNT." });

// Convert Firestore Timestamps to ISO strings for JSON responses
function serialize(doc) {
  const raw = doc.data();
  const out = { id: doc.id };
  for (const [k, v] of Object.entries(raw))
    out[k] = v?.toDate ? v.toDate().toISOString() : v;
  return out;
}

// Upload image to Firebase Storage and return a public download URL
async function uploadImage(file) {
  if (!bucket) throw new Error("Storage not initialized");
  const token    = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
  const key      = `products/${Date.now()}_${safeName}`;
  await bucket.file(key).save(file.buffer, {
    metadata: {
      contentType: file.mimetype,
      metadata   : { firebaseStorageDownloadTokens: token },
    },
  });
  const enc = encodeURIComponent(key);
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${enc}?alt=media&token=${token}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN AUTH
// ══════════════════════════════════════════════════════════════════════════════
app.post("/api/auth/login", (req, res) => {
  if (req.body.username === ADMIN_USER && req.body.password === ADMIN_PASS) {
    req.session.isAdmin = true; res.json({ success: true });
  } else res.status(401).json({ error: "Invalid credentials" });
});
app.post("/api/auth/logout", (req, res) =>
  req.session.destroy(() => res.json({ success: true })));
app.get("/api/auth/check", (req, res) =>
  res.json({ isAdmin: !!req.session?.isAdmin }));

// ══════════════════════════════════════════════════════════════════════════════
// PRODUCTS CRUD
// ══════════════════════════════════════════════════════════════════════════════
app.get("/api/products", requireAuth, requireDb, async (_, res) => {
  try {
    const snap = await db.collection("products").orderBy("createdAt", "desc").get();
    res.json(snap.docs.map(serialize));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/products", requireAuth, requireDb, upload.single("image"), async (req, res) => {
  try {
    const b = req.body;
    const doc = {
      name           : b.name,
      storage        : b.storage        || "",
      color          : b.color          || "",
      warranty       : b.warranty       === "true",
      warrantyDetails: b.warrantyDetails || "",
      isIphone       : b.isIphone       === "true",
      batteryHealth  : b.isIphone === "true" ? (b.batteryHealth || "") : null,
      status         : b.status         || "instock",
      description    : b.description    || "",
      imageUrl       : req.file ? await uploadImage(req.file) : null,
      createdAt      : new Date(),
    };
    const ref = await db.collection("products").add(doc);
    res.json({ id: ref.id, ...doc });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/products/:id", requireAuth, requireDb, upload.single("image"), async (req, res) => {
  try {
    const b = req.body;
    const upd = {
      name           : b.name,
      storage        : b.storage        || "",
      color          : b.color          || "",
      warranty       : b.warranty       === "true",
      warrantyDetails: b.warrantyDetails || "",
      isIphone       : b.isIphone       === "true",
      batteryHealth  : b.isIphone === "true" ? (b.batteryHealth || "") : null,
      status         : b.status         || "instock",
      description    : b.description    || "",
      updatedAt      : new Date(),
    };
    if (req.file) upd.imageUrl = await uploadImage(req.file);
    await db.collection("products").doc(req.params.id).update(upd);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/products/:id", requireAuth, requireDb, async (req, res) => {
  try {
    await db.collection("products").doc(req.params.id).delete();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// LEADS
// ══════════════════════════════════════════════════════════════════════════════
app.get("/api/leads", requireAuth, requireDb, async (_, res) => {
  try {
    const snap = await db.collection("leads").orderBy("createdAt", "desc").get();
    res.json(snap.docs.map(serialize));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/leads/:id/status", requireAuth, requireDb, async (req, res) => {
  try {
    await db.collection("leads").doc(req.params.id)
      .update({ status: req.body.status, updatedAt: new Date() });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/leads/:id", requireAuth, requireDb, async (req, res) => {
  try {
    await db.collection("leads").doc(req.params.id).delete();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin panel (SPA at root) ──────────────────────────────────────────────────
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ══════════════════════════════════════════════════════════════════════════════
// TELEGRAM BOT
// ══════════════════════════════════════════════════════════════════════════════

// In-memory conversation states: chatId → { state, data }
const userStates   = new Map();
let   prodCache    = [];
let   prodCacheTTL = 0;

async function fetchProducts() {
  if (!db) return [];
  if (Date.now() < prodCacheTTL && prodCache.length) return prodCache;
  try {
    const snap = await db.collection("products").get();
    prodCache  = snap.docs.map(serialize);
    prodCacheTTL = Date.now() + 5 * 60 * 1000;
  } catch (e) { console.error("Product cache refresh:", e.message); }
  return prodCache;
}

function buildCatalog(products) {
  const avail = products.filter(p => p.status !== "sold");
  if (!avail.length) return "No phones available currently.";
  return avail.map(p => {
    let s = `• ${p.name} | ${p.storage} | ${p.color}`;
    if (p.warranty) s += ` | Warranty: ${p.warrantyDetails || "Yes"}`;
    if (p.isIphone && p.batteryHealth) s += ` | Battery: ${p.batteryHealth}`;
    s += ` | ${p.status === "instock" ? "In Stock" : "On Sale"}`;
    return s;
  }).join("\n");
}

function matchProduct(query, products) {
  const q = query.toLowerCase();
  return products.find(p =>
    p.name.toLowerCase().split(/\s+/).some(w => w.length >= 3 && q.includes(w))
  ) || null;
}

// Smart filter: score each in-stock product against the user's search query
function filterProducts(query, products) {
  const q     = query.toLowerCase().trim();
  const avail = products.filter(p => p.status !== "sold");

  // "all" / "badha" / "sab" → show everything
  if (/\b(all|badha|sab|tamam|everything|dakhav|show all)\b/.test(q)) return avail;

  const scored = avail.map(p => {
    let score = 0;
    const name    = (p.name    || "").toLowerCase();
    const storage = (p.storage || "").toLowerCase().replace(/\s/g, "");
    const color   = (p.color   || "").toLowerCase();

    // Name / brand word match
    for (const w of q.split(/\s+/).filter(w => w.length >= 3)) {
      if (name.includes(w)) score += 3;
    }

    // Storage match — handle "256", "256gb", "256 gb"
    const qNum = q.match(/\b(\d{2,4})\s*gb\b/)?.[1];
    if (qNum && storage.replace("gb", "").includes(qNum)) score += 3;

    // Color match
    if (color && q.includes(color)) score += 2;
    if (color && color.split(/\s+/).some(w => q.includes(w))) score += 1;

    // iPhone / Apple
    if (/\b(iphone|apple)\b/.test(q) && p.isIphone) score += 5;
    if (/\b(android|non.?iphone)\b/.test(q) && !p.isIphone) score += 3;

    // Warranty requested
    if (/\b(warranty|guarantee|warenti|waranti)\b/.test(q) && p.warranty) score += 2;

    // Battery health requested (iPhone)
    if (/\b(battery|batt|battri)\b/.test(q) && p.batteryHealth) score += 2;

    return { p, score };
  });

  const matched = scored
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(x => x.p);

  // Fallback: if nothing scored, show all available so user is never left empty-handed
  return matched.length ? matched : avail;
}

const INTEREST_KW = [
  "buy","purchase","interested","want","kharidi","kharidna","kharchu",
  "levo","lena","chahiye","book","order","how much","ketlu","kitna",
  "available","stock","contact","call me","whatsapp","levi che","lena hai",
];
const hasInterest = t => INTEREST_KW.some(k => t.toLowerCase().includes(k));

// ── Language utilities ─────────────────────────────────────────────────────────
function detectLang(text) {
  if (/[઀-૿]/.test(text)) return "gu"; // Gujarati Unicode block
  if (/[ऀ-ॿ]/.test(text)) return "hi"; // Devanagari (Hindi)
  return "en";
}

function tgLangCode(msg) {
  const lc = msg.from?.language_code || "en";
  if (lc.startsWith("gu")) return "gu";
  if (lc.startsWith("hi")) return "hi";
  return "en";
}

// Single-language message templates — no mixing, ever
const L = {
  namePrompt: {
    gu: "તમારું નામ શું છે?",
    hi: "आपका नाम क्या है?",
    en: "What's your name?",
  },
  nameRepeat: {
    gu: "કૃપા કરી તમારું નામ type કરો:",
    hi: "कृपया अपना नाम type करें:",
    en: "Please type your name:",
  },
  phonePrompt: (name) => ({
    gu: `આભાર, *${name}*! 😊\nહવે તમારો *10 આંકડાનો* મોબાઇલ નંબર આપો:`,
    hi: `शुक्रिया, *${name}*! 😊\nअब अपना *10 अंकों का* मोबाइल नंबर दें:`,
    en: `Thanks, *${name}*! 😊\nNow your *10-digit* mobile number please:`,
  }),
  badPhone: {
    gu: "સાચો 10 આંકડાનો નંબર આપો.",
    hi: "सही 10 अंकों का नंबर दें।",
    en: "Please enter a valid 10-digit number.",
  },
  thankYou: (name) => ({
    gu: `✅ *આભાર, ${name}!*\nઅમારી team ટૂંક સમયમાં તમને call કરશે. 🙏`,
    hi: `✅ *शुक्रिया, ${name}!*\nहमारी team जल्द आपको call करेगी। 🙏`,
    en: `✅ *Thank you, ${name}!*\nOur team will call you very soon. 🙏`,
  }),
  noStock: {
    gu: "અત્યારે stock ખાલી છે. ટૂંક સમયમાં નવા phones આવશે! 📱",
    hi: "अभी stock खाली है। जल्द नए phones आएंगे! 📱",
    en: "No phones in stock right now. New ones coming soon! 📱",
  },
  phonesAsk: {
    gu: "📱 *કેવો phone જોઈએ છે?*\n\nBrand, model, storage, color — જે જાણો તે જણાવો:\n_અથવા બધા phones જોવા* all *type કરો._",
    hi: "📱 *कैसा phone चाहिए?*\n\nBrand, model, storage, color — जो पता हो बताएं:\n_या सब phones देखने के लिए* all *type करें।_",
    en: "📱 *What are you looking for?*\n\nTell me the brand, model, storage or color:\n_Or type *all* to see everything in stock._",
  },
  noMatch: {
    gu: "આ search માં match નથી. /phones ફરી try કરો.",
    hi: "इस search में कोई match नहीं। /phones से दोबारा try करें।",
    en: "No match found for that. Try /phones to search again.",
  },
  foundCount: (n) => ({
    gu: `_${n} phones મળ્યા. કોઈ પણ phone વિશે પૂછો!_`,
    hi: `_${n} phones मिले। किसी भी phone के बारे में पूछें!_`,
    en: `_${n} phones found. Ask me anything about any of them!_`,
  }),
  error: {
    gu: "⚠️ Error આવ્યો. થોડી વારમાં ફરી try કરજો.",
    hi: "⚠️ Error आई। थोड़ी देर बाद try करें।",
    en: "⚠️ Something went wrong. Please try again.",
  },
};

function lget(key, lang, ...args) {
  const val = L[key];
  const resolved = typeof val === "function" ? val(...args) : val;
  return resolved[lang] || resolved["en"];
}

// ── Sarvam AI — powerful prompt ────────────────────────────────────────────────
async function callSarvam(userText, catalog) {
  const sys = `You are iBell AI — the expert sales assistant at iBell Mobiles, a trusted shop for premium used and refurbished smartphones.

━━━ LANGUAGE RULE (HIGHEST PRIORITY) ━━━
Read the user's message and identify the language precisely:
• If they write in Gujarati script → reply in pure, natural Gujarati only.
• If they write in Hindi / Devanagari → reply in pure, natural Hindi only.
• If they write in English → reply in clean English only.
• If they mix Hindi + English (Hinglish) → reply in pure Hindi, not Hinglish.
• If they mix Gujarati + English → reply in pure Gujarati.
NEVER write in two languages in one reply. ONE language per message, no exceptions.

━━━ PERSONALITY ━━━
• Think of yourself as a smart, helpful friend who knows phones inside out — not a corporate chatbot.
• Be direct and natural. No filler like "Great question!" or "Of course, I'd be happy to help!"
• Keep replies short: 2–4 sentences unless the customer specifically asks for details.
• Use 1–2 relevant emojis per reply — never more.
• Never sound scripted. Be conversational and genuine.

━━━ YOUR GOAL ━━━
• Help customers find the right phone from the catalog below.
• Answer questions about specs, condition, warranty, and battery health confidently.
• When a customer shows buying intent — says "I want it", "how to buy", asks about availability — naturally tell them our team will assist personally, then put [INTEREST] on the last line of your reply. Nothing after it.
• Be helpful, never pushy.

━━━ PRODUCT RULES ━━━
• Only discuss phones in the catalog. Never invent models, specs, or prices.
• If a phone isn't in the catalog: "We don't have that one right now."
• Always mention warranty status when relevant — buyers care about it.
• For iPhones, battery health is key — mention it proactively.

━━━ CURRENT STOCK ━━━
${catalog}`;

  const r = await axios.post(
    "https://api.sarvam.ai/v1/chat/completions",
    {
      model      : "sarvam-105b",
      messages   : [{ role: "system", content: sys }, { role: "user", content: userText }],
      temperature: 0.35,
      max_tokens : 600,
    },
    {
      headers: { "api-subscription-key": SARVAM_API_KEY, "Content-Type": "application/json" },
      timeout: 30000,
    }
  );
  return r.data?.choices?.[0]?.message?.content || "";
}

// Dedicated welcome generator for /start — fully AI-driven, language-aware
async function generateWelcome(name, langCode) {
  const langName = langCode === "gu" ? "Gujarati" : langCode === "hi" ? "Hindi" : "English";
  const sys = `You are iBell AI, the friendly assistant for iBell Mobiles — a trusted used smartphone shop.
Write a warm, natural welcome message for a new customer named "${name}".
- Language: ${langName} ONLY. Pure language, zero mixing.
- Introduce yourself briefly as iBell AI.
- Tell them they can ask about any phone, or type /phones to see what's available.
- 2–3 sentences maximum. Feel like a real person, not a script.
- One emoji is enough.`;

  try {
    const r = await axios.post(
      "https://api.sarvam.ai/v1/chat/completions",
      {
        model      : "sarvam-105b",
        messages   : [{ role: "system", content: sys }, { role: "user", content: "Start" }],
        temperature: 0.6,
        max_tokens : 150,
      },
      {
        headers: { "api-subscription-key": SARVAM_API_KEY, "Content-Type": "application/json" },
        timeout: 15000,
      }
    );
    return r.data?.choices?.[0]?.message?.content || null;
  } catch { return null; }
}

// Telegram helpers
const TG = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

async function tgText(chatId, text) {
  try {
    await axios.post(`${TG}/sendMessage`, { chat_id: chatId, text, parse_mode: "Markdown" });
  } catch {
    await axios.post(`${TG}/sendMessage`, { chat_id: chatId, text }).catch(() => {});
  }
}

async function tgPhoto(chatId, url, caption) {
  try {
    await axios.post(`${TG}/sendPhoto`, {
      chat_id   : chatId,
      photo     : url,
      caption   : caption?.slice(0, 1024),
      parse_mode: "Markdown",
    });
    return true;
  } catch { return false; }
}

async function tgTyping(chatId) {
  await axios.post(`${TG}/sendChatAction`, { chat_id: chatId, action: "typing" }).catch(() => {});
}

async function setWebhook() {
  const url = `${WEBHOOK_URL}/webhook/${TELEGRAM_TOKEN}`;
  const r   = await axios.post(`${TG}/setWebhook`, { url, drop_pending_updates: true });
  console.log("Webhook →", url, "|", r.data.description);
}

// Main message handler
async function handleMessage(msg) {
  const chatId   = msg.chat.id;
  const rawText  = (msg.text || "").trim();
  const fromName = msg.from.first_name || "Friend";
  const uname    = msg.from.username   || "";

  // Load state; preserve detected language across turns
  const st   = userStates.get(chatId) || { state: "idle", data: {}, lang: tgLangCode(msg) };
  const lang = rawText && !rawText.startsWith("/") ? detectLang(rawText) : (st.lang || tgLangCode(msg));

  // Persist updated language if we detected something from real text
  if (rawText && !rawText.startsWith("/")) {
    userStates.set(chatId, { ...st, lang });
  }

  // ── Collecting customer name ───────────────────────────────────────────────
  if (st.state === "collecting_name") {
    if (!rawText || rawText.startsWith("/"))
      return tgText(chatId, lget("nameRepeat", lang));
    userStates.set(chatId, { ...st, state: "collecting_phone", lang, data: { ...st.data, name: rawText } });
    return tgText(chatId, lget("phonePrompt", lang, rawText));
  }

  // ── Collecting customer phone ──────────────────────────────────────────────
  if (st.state === "collecting_phone") {
    const digits = rawText.replace(/\D/g, "");
    if (digits.length < 10)
      return tgText(chatId, lget("badPhone", lang));
    try {
      if (db) await db.collection("leads").add({
        name            : st.data.name,
        phone           : digits,
        chatId,
        telegramUsername: uname,
        telegramName    : fromName,
        interestedIn    : st.data.product || "General Inquiry",
        status          : "new",
        createdAt       : new Date(),
      });
    } catch (e) { console.error("Lead save error:", e.message); }
    userStates.set(chatId, { state: "idle", data: {}, lang });
    return tgText(chatId, lget("thankYou", lang, st.data.name));
  }

  // ── Searching phones (reply to /phones question) ───────────────────────────
  if (st.state === "searching_phones") {
    userStates.set(chatId, { state: "idle", data: {}, lang });
    await tgTyping(chatId);
    const products = await fetchProducts();
    const matched  = filterProducts(rawText, products);

    if (!matched.length)
      return tgText(chatId, lget("noMatch", lang));

    for (const p of matched) {
      const cap =
        `📱 *${p.name}*\n` +
        `💾 ${p.storage}  🎨 ${p.color}\n` +
        `🛡️ Warranty: ${p.warranty ? (p.warrantyDetails || "Yes") : "No"}\n` +
        (p.isIphone && p.batteryHealth ? `🔋 Battery Health: ${p.batteryHealth}\n` : "") +
        `📦 ${p.status === "sale" ? "🔥 On Sale" : "✅ In Stock"}` +
        (p.description ? `\n\n_${p.description}_` : "");
      if (p.imageUrl) await tgPhoto(chatId, p.imageUrl, cap);
      else await tgText(chatId, cap);
    }

    if (matched.length > 1)
      await tgText(chatId, lget("foundCount", lang, matched.length));
    return;
  }

  // ── /start — AI-generated welcome in detected language ────────────────────
  if (rawText === "/start") {
    await tgTyping(chatId);
    const welcome = await generateWelcome(fromName, lang);
    return tgText(chatId, welcome || `Hi ${fromName}! I'm iBell AI. Ask about any phone or type /phones to see what's available. 📱`);
  }

  // ── /help ─────────────────────────────────────────────────────────────────
  if (rawText === "/help")
    return tgText(chatId,
      `*iBell AI*\n\n` +
      `/phones — Browse available phones\n` +
      `/start  — Start over\n` +
      `/help   — This menu\n\n` +
      `💬 Just ask me about any phone!`);

  // ── /phones — ask what they want ──────────────────────────────────────────
  if (rawText === "/phones") {
    const products = await fetchProducts();
    const avail    = products.filter(p => p.status !== "sold");
    if (!avail.length) return tgText(chatId, lget("noStock", lang));
    userStates.set(chatId, { state: "searching_phones", data: {}, lang });
    return tgText(chatId, lget("phonesAsk", lang));
  }

  if (!rawText) return;

  // ── AI response ────────────────────────────────────────────────────────────
  await tgTyping(chatId);
  try {
    const products = await fetchProducts();
    const catalog  = buildCatalog(products);
    const matched  = matchProduct(rawText, products);
    const reply    = await callSarvam(rawText, catalog);
    const interest = reply.includes("[INTEREST]") || hasInterest(rawText);
    const clean    = reply.replace(/\[INTEREST\]/g, "").trim();

    if (matched?.imageUrl) {
      const ok = await tgPhoto(chatId, matched.imageUrl, clean.slice(0, 1024));
      if (!ok || clean.length > 1024) await tgText(chatId, clean);
    } else {
      await tgText(chatId, clean);
    }

    if (interest) {
      await new Promise(r => setTimeout(r, 700));
      userStates.set(chatId, { state: "collecting_name", data: { product: matched?.name || "" }, lang });
      await tgText(chatId, lget("namePrompt", lang));
    }
  } catch (e) {
    console.error("Bot error:", e?.response?.data || e.message);
    await tgText(chatId, lget("error", lang));
  }
}

// ── Webhook ────────────────────────────────────────────────────────────────────
app.post(`/webhook/${TELEGRAM_TOKEN}`, (req, res) => {
  res.sendStatus(200);
  if (req.body?.message) handleMessage(req.body.message).catch(console.error);
});

// ── Health ─────────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok", time: new Date().toISOString() }));

function keepAlive(url) {
  setInterval(() =>
    axios.get(`${url}/health`, { timeout: 10000 }).catch(() => {}),
  14 * 60 * 1000);
}

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`iBell AI running on port ${PORT}`);
  if (WEBHOOK_URL) {
    try { await setWebhook(); } catch (e) { console.error("Webhook error:", e.message); }
    keepAlive(WEBHOOK_URL);
  } else {
    console.warn("WEBHOOK_URL not set — add it in Render env vars");
  }
});
