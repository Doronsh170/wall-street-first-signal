import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import fs from "fs";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const PORT = process.env.PORT || 8787;
const tickerMap = JSON.parse(fs.readFileSync("./data/ticker_map.json", "utf8"));
const sourceRules = JSON.parse(fs.readFileSync("./data/source_rules.json", "utf8"));

const clients = new Set();
const eventStore = [];
const seenFingerprints = new Map();

const DEDUPE_WINDOW_MS = 3 * 60 * 1000;
const MAX_EVENTS = 200;

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value = "") {
  return String(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function compact(value = "", max = 220) {
  const s = String(value || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function fingerprint(text) {
  return normalizeText(text).replace(/[^a-z0-9$ ]/g, "").slice(0, 180);
}

function detectSourceTier(source = "", author = "") {
  const haystack = normalizeText(`${source} ${author}`);
  for (const [tier, rule] of Object.entries(sourceRules.tiers)) {
    if (rule.patterns.some((p) => haystack.includes(normalizeText(p)))) {
      return { tier, score: rule.score };
    }
  }
  return { tier: "market_chatter", score: sourceRules.tiers.market_chatter.score };
}

function extractCashTickers(text = "") {
  const matches = String(text).match(/\$[A-Z]{1,5}\b/g) || [];
  const blacklist = new Set(["$AI"]);
  return [...new Set(matches.map((m) => m.slice(1)).filter((t) => !blacklist.has(`$${t}`)))];
}

function resolveThemes(text = "") {
  const n = normalizeText(text);
  const themes = [];
  for (const [key, meta] of Object.entries(tickerMap)) {
    const hits = meta.keywords.filter((kw) => n.includes(normalizeText(kw)));
    if (hits.length > 0) {
      themes.push({
        key,
        label: meta.label,
        hits,
        primary: meta.primary,
        secondary: meta.secondary
      });
    }
  }
  return themes;
}

function policyTermScore(text = "") {
  const n = normalizeText(text);
  let score = 0;
  const matched = [];
  for (const term of sourceRules.policy_terms.high) {
    if (n.includes(term)) {
      score += 14;
      matched.push(term);
    }
  }
  for (const term of sourceRules.policy_terms.medium) {
    if (n.includes(term)) {
      score += 8;
      matched.push(term);
    }
  }
  for (const term of sourceRules.policy_terms.low) {
    if (n.includes(term)) {
      score += 3;
      matched.push(term);
    }
  }
  return { score: Math.min(score, 45), matched: [...new Set(matched)] };
}

function detectTrumpLink(text = "", source = "", author = "") {
  const n = normalizeText(`${text} ${source} ${author}`);
  const terms = ["trump", "realdonaldtrump", "truth social", "trump administration", "donald j. trump"];
  return terms.some((term) => n.includes(term));
}

function buildRelatedTickers(cashTickers, themes) {
  const byTicker = new Map();

  for (const t of cashTickers) {
    byTicker.set(t, { ticker: t, name: t, role: "mentioned", sensitivity: "direct" });
  }

  for (const theme of themes) {
    for (const item of theme.primary) {
      if (!byTicker.has(item.ticker)) {
        byTicker.set(item.ticker, { ...item, role: "theme-primary" });
      }
    }
    for (const item of theme.secondary) {
      if (!byTicker.has(item.ticker)) {
        byTicker.set(item.ticker, { ...item, role: "theme-secondary" });
      }
    }
  }

  return [...byTicker.values()].slice(0, 14);
}

function classifyVerification(sourceTier) {
  if (sourceTier === "trump_direct") return "Direct Trump / first signal";
  if (sourceTier === "official") return "Official source";
  if (sourceTier === "tier1_media") return "Tier-1 media";
  if (sourceTier === "trusted_x") return "Trusted X / needs verification";
  return "Market chatter / low confidence";
}

function computeSignal({ text, source, author }) {
  const cashTickers = extractCashTickers(text);
  const themes = resolveThemes(text);
  const { tier, score: sourceScore } = detectSourceTier(source, author);
  const p = policyTermScore(text);
  const trumpLinked = detectTrumpLink(text, source, author);
  const relatedTickers = buildRelatedTickers(cashTickers, themes);

  let score = sourceScore + p.score;
  if (trumpLinked) score += 20;
  if (cashTickers.length > 0) score += 10;
  if (themes.length > 0) score += 15;
  if (relatedTickers.some((x) => x.sensitivity === "high")) score += 8;

  score = Math.max(0, Math.min(100, score));

  let level = "LOW";
  if (score >= 80) level = "HIGH";
  else if (score >= 55) level = "MEDIUM";

  const reasonParts = [];
  if (trumpLinked) reasonParts.push("Trump / administration linkage");
  if (themes.length) reasonParts.push(`Theme detected: ${themes.map((t) => t.label).join(", ")}`);
  if (p.matched.length) reasonParts.push(`Policy terms: ${p.matched.slice(0, 5).join(", ")}`);
  if (cashTickers.length) reasonParts.push(`Direct tickers: ${cashTickers.map((t) => "$" + t).join(", ")}`);

  return {
    id: crypto.randomUUID(),
    createdAt: nowIso(),
    text: compact(text, 600),
    source: source || "unknown",
    author: author || "",
    url: "",
    sourceTier: tier,
    verification: classifyVerification(tier),
    trumpLinked,
    cashTickers,
    themes: themes.map(({ key, label, hits }) => ({ key, label, hits })),
    relatedTickers,
    policyTerms: p.matched,
    score,
    level,
    reasons: reasonParts,
    status: "FIRST_SIGNAL"
  };
}

function shouldAlert(signal) {
  if (signal.score >= 55) return true;
  if (signal.sourceTier === "trump_direct" && (signal.themes.length || signal.cashTickers.length)) return true;
  if (signal.sourceTier === "official" && (signal.themes.length || signal.cashTickers.length)) return true;
  if (signal.sourceTier === "tier1_media" && signal.trumpLinked) return true;
  return false;
}

function cleanDedupe() {
  const cutoff = Date.now() - DEDUPE_WINDOW_MS;
  for (const [key, value] of seenFingerprints.entries()) {
    if (value < cutoff) seenFingerprints.delete(key);
  }
}

function publish(event) {
  eventStore.unshift(event);
  if (eventStore.length > MAX_EVENTS) eventStore.pop();

  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }

  sendTelegram(event).catch((err) => {
    console.error("Telegram send failed:", err.message);
  });
}

async function sendTelegram(event) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const tickers = event.relatedTickers.map((x) => `$${x.ticker}`).slice(0, 8).join(", ");
  const msg = [
    "🚨 FIRST SIGNAL",
    "",
    `Score: ${event.score}/100 | ${event.level}`,
    `Source: ${event.source}${event.author ? " / " + event.author : ""}`,
    `Verification: ${event.verification}`,
    `Tickers: ${tickers || "N/A"}`,
    "",
    event.text,
    "",
    `Reasons: ${event.reasons.join(" | ") || "N/A"}`
  ].join("\n");

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: msg,
      disable_web_page_preview: true
    })
  });
}

app.get("/api/events", (req, res) => {
  res.json(eventStore.slice(0, 100));
});

app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  clients.add(res);
  res.write(`data: ${JSON.stringify({ type: "CONNECTED", createdAt: nowIso() })}\n\n`);

  req.on("close", () => {
    clients.delete(res);
  });
});

app.post("/api/ingest", (req, res) => {
  const { text, source, author, url } = req.body || {};
  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "Missing text" });
  }

  cleanDedupe();
  const fp = fingerprint(text);
  if (seenFingerprints.has(fp)) {
    return res.json({ status: "duplicate_ignored" });
  }

  const signal = computeSignal({ text, source, author });
  signal.url = url || "";

  if (!shouldAlert(signal)) {
    return res.json({ status: "ignored_low_signal", signal });
  }

  seenFingerprints.set(fp, Date.now());
  publish(signal);
  res.json({ status: "published", signal });
});

app.post("/api/simulate", (req, res) => {
  const examples = [
    {
      source: "Truth Social",
      author: "realDonaldTrump",
      text: "The Trump administration is preparing major support for American drone manufacturers to strengthen domestic defense supply chains."
    },
    {
      source: "Reuters",
      author: "Reuters",
      text: "Trump administration is in talks to fund U.S. drone companies as part of a broader national security push."
    },
    {
      source: "Commerce Department / NIST",
      author: "official",
      text: "Commerce Department announces letters of intent to quantum computing companies for strategic funding support."
    },
    {
      source: "X",
      author: "FirstSquawk",
      text: "WHITE HOUSE CONSIDERING NEW CHINA TARIFFS ON ADVANCED SEMICONDUCTOR EQUIPMENT, TRADERS WATCH $NVDA $AMD $ASML $TSM."
    }
  ];
  const item = examples[Math.floor(Math.random() * examples.length)];
  const signal = computeSignal(item);
  signal.text = item.text;
  publish(signal);
  res.json({ status: "simulated", signal });
});

async function startXStream() {
  const bearer = process.env.X_BEARER_TOKEN;
  if (!bearer) {
    console.log("X stream disabled: X_BEARER_TOKEN not set.");
    return;
  }

  console.log("Starting X filtered stream listener...");
  const url = "https://api.twitter.com/2/tweets/search/stream?tweet.fields=created_at,author_id&expansions=author_id&user.fields=username,verified,public_metrics";

  while (true) {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${bearer}` }
      });

      if (!response.ok) {
        console.error("X stream HTTP error:", response.status, await response.text());
        await new Promise((r) => setTimeout(r, 15000));
        continue;
      }

      let buffer = "";
      for await (const chunk of response.body) {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const parsed = JSON.parse(trimmed);
            const text = parsed?.data?.text || "";
            const authorId = parsed?.data?.author_id || "";
            const user = parsed?.includes?.users?.find((u) => u.id === authorId);
            const author = user?.username || authorId || "x_stream";
            const signal = computeSignal({ text, source: "X", author });
            signal.url = parsed?.data?.id ? `https://x.com/${author}/status/${parsed.data.id}` : "";

            const fp = fingerprint(text);
            cleanDedupe();
            if (!seenFingerprints.has(fp) && shouldAlert(signal)) {
              seenFingerprints.set(fp, Date.now());
              publish(signal);
            }
          } catch (e) {
            console.error("X parse error:", e.message);
          }
        }
      }
    } catch (err) {
      console.error("X stream connection error:", err.message);
      await new Promise((r) => setTimeout(r, 15000));
    }
  }
}

app.listen(PORT, () => {
  console.log(`Wall Street First Signal MVP running on http://localhost:${PORT}`);
  startXStream();
});
