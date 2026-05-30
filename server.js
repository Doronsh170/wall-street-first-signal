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
const seenTweetIds = new Set();

const DEDUPE_WINDOW_MS = 3 * 60 * 1000;
const MAX_EVENTS = 200;

// TwitterAPI.io / Kaito polling
const TWITTER_API_KEY = process.env.TWITTER_API_KEY || "";
const MONITOR_X_ACCOUNTS = (process.env.MONITOR_X_ACCOUNTS || "JustTrumpTruth")
  .split(",")
  .map((x) => x.replace("@", "").trim())
  .filter(Boolean);
const X_POLL_INTERVAL_SEC = Math.max(30, Number(process.env.X_POLL_INTERVAL_SEC || 60));
let hasSeededInitialTweets = false;

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

  if (haystack.includes("justtrumptruth")) {
    return { tier: "trump_proxy", score: 34 };
  }

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
  const terms = [
    "trump",
    "realdonaldtrump",
    "truth social",
    "trump administration",
    "donald j. trump",
    "justtrumptruth"
  ];
  return terms.some((term) => n.includes(term));
}

function buildRelatedTickers(cashTickers, themes) {
  const byTicker = new Map();

  for (const t of cashTickers) {
    byTicker.set(t, { ticker: t, name: t, role: "mentioned", sensitivity: "direct" });
  }

  for (const theme of themes) {
    for (const item of theme.primary) {
      if (!byTicker.has(item.ticker)) byTicker.set(item.ticker, { ...item, role: "theme-primary" });
    }
    for (const item of theme.secondary) {
      if (!byTicker.has(item.ticker)) byTicker.set(item.ticker, { ...item, role: "theme-secondary" });
    }
  }

  return [...byTicker.values()].slice(0, 14);
}

function classifyVerification(sourceTier) {
  if (sourceTier === "trump_direct") return "Direct Trump / first signal";
  if (sourceTier === "trump_proxy") return "Trump proxy / needs confirmation";
  if (sourceTier === "official") return "Official source";
  if (sourceTier === "tier1_media") return "Tier-1 media";
  if (sourceTier === "trusted_x") return "Trusted X / needs verification";
  return "Market chatter / low confidence";
}

function computeSignal({ text, source, author, externalId, createdAt }) {
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
    externalId: externalId || "",
    createdAt: createdAt || nowIso(),
    text: compact(text, 900),
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
    status: source === "SIMULATION" ? "SIMULATION" : "LIVE_FIRST_SIGNAL"
  };
}

function shouldAlert(signal) {
  if (signal.score >= 55) return true;
  if (signal.sourceTier === "trump_proxy" && (signal.themes.length || signal.cashTickers.length || signal.policyTerms.length)) return true;
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
  for (const res of clients) res.write(payload);

  sendTelegram(event).catch((err) => {
    console.error("Telegram send failed:", err.message);
  });
}

async function sendTelegram(event) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const tickers = event.relatedTickers.map((x) => `$${x.ticker}`).slice(0, 8).join(", ");
  const sourceLine = event.author ? `${event.source} / ${event.author}` : event.source;

  const msg = [
    event.status === "SIMULATION" ? "🧪 SIMULATION ALERT" : "🚨 LIVE FIRST SIGNAL",
    "",
    `Score: ${event.score}/100 | ${event.level}`,
    `Source: ${sourceLine}`,
    `Verification: ${event.verification}`,
    `Tickers: ${tickers || "N/A"}`,
    event.url ? `URL: ${event.url}` : "",
    "",
    event.text,
    "",
    `Reasons: ${event.reasons.join(" | ") || "N/A"}`
  ].filter(Boolean).join("\n");

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: msg,
      disable_web_page_preview: false
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

  req.on("close", () => clients.delete(res));
});

app.post("/api/ingest", (req, res) => {
  const { text, source, author, url, externalId } = req.body || {};
  if (!text || typeof text !== "string") return res.status(400).json({ error: "Missing text" });

  cleanDedupe();
  const fp = fingerprint(text);
  if (seenFingerprints.has(fp)) return res.json({ status: "duplicate_ignored" });

  const signal = computeSignal({ text, source, author, externalId });
  signal.url = url || "";

  if (!shouldAlert(signal)) return res.json({ status: "ignored_low_signal", signal });

  seenFingerprints.set(fp, Date.now());
  publish(signal);
  res.json({ status: "published", signal });
});

app.post("/api/simulate", (req, res) => {
  const examples = [
    { source: "SIMULATION", author: "Demo", text: "The Trump administration is preparing major support for American drone manufacturers to strengthen domestic defense supply chains." },
    { source: "SIMULATION", author: "Demo", text: "Trump administration is in talks to fund U.S. drone companies as part of a broader national security push." },
    { source: "SIMULATION", author: "Demo", text: "Commerce Department announces letters of intent to quantum computing companies for strategic funding support." },
    { source: "SIMULATION", author: "Demo", text: "WHITE HOUSE CONSIDERING NEW CHINA TARIFFS ON ADVANCED SEMICONDUCTOR EQUIPMENT, TRADERS WATCH $NVDA $AMD $ASML $TSM." }
  ];

  const item = examples[Math.floor(Math.random() * examples.length)];
  const signal = computeSignal(item);
  signal.text = item.text;
  publish(signal);
  res.json({ status: "simulated", signal });
});

function getTweetText(tweet) {
  return tweet?.text || tweet?.full_text || tweet?.content || tweet?.note_tweet?.text || "";
}

function getTweetId(tweet) {
  return String(tweet?.id || tweet?.tweet_id || tweet?.tweetId || tweet?.rest_id || "");
}

function getTweetUrl(tweet, username) {
  if (tweet?.url) return tweet.url;
  const id = getTweetId(tweet);
  return id ? `https://x.com/${username}/status/${id}` : "";
}

function extractTweetsFromTwitterApiResponse(json) {
  if (Array.isArray(json?.tweets)) return json.tweets;
  if (Array.isArray(json?.data?.tweets)) return json.data.tweets;
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.results)) return json.results;
  if (Array.isArray(json?.result?.tweets)) return json.result.tweets;
  return [];
}

async function fetchLatestTweetsForUser(username) {
  // TwitterAPI.io official docs currently show this endpoint:
  // GET https://api.twitterapi.io/twitter/user/last_tweets
  // Required header: X-API-Key
  // Query: userName, includeReplies, cursor
  const endpoints = [
    "https://api.twitterapi.io/twitter/user/last_tweets",
    // Fallback kept for accounts/docs that still expose the older alias.
    "https://api.twitterapi.io/twitter/user/latest_tweets"
  ];

  let lastError = null;

  for (const endpoint of endpoints) {
    const url = new URL(endpoint);
    url.searchParams.set("userName", username);
    url.searchParams.set("includeReplies", "false");
    url.searchParams.set("cursor", "");

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "X-API-Key": TWITTER_API_KEY,
        "Accept": "application/json"
      }
    });

    const raw = await response.text();

    if (!response.ok) {
      lastError = `TwitterAPI.io error ${response.status} from ${endpoint}: ${raw.slice(0, 300)}`;
      continue;
    }

    try {
      const json = JSON.parse(raw);
      const count = extractTweetsFromTwitterApiResponse(json).length;
      console.log(`TwitterAPI.io endpoint ${endpoint} returned ${count} tweets for @${username}`);

      if (count === 0) {
        console.log(`TwitterAPI.io raw preview for @${username}: ${raw.slice(0, 500)}`);
      }

      return json;
    } catch (err) {
      lastError = `TwitterAPI.io JSON parse failed from ${endpoint}: ${raw.slice(0, 300)}`;
    }
  }

  throw new Error(lastError || "TwitterAPI.io request failed");
}

async function pollTwitterApiOnce({ seedOnly = false } = {}) {
  if (!TWITTER_API_KEY) {
    console.log("TwitterAPI.io polling disabled: TWITTER_API_KEY not set.");
    return { status: "disabled" };
  }

  const results = [];

  for (const username of MONITOR_X_ACCOUNTS) {
    try {
      const json = await fetchLatestTweetsForUser(username);
      const tweets = extractTweetsFromTwitterApiResponse(json);
      console.log(`TwitterAPI.io: fetched ${tweets.length} tweets for @${username}`);

      const ordered = tweets.slice().reverse();

      for (const tweet of ordered) {
        const id = getTweetId(tweet);
        const text = getTweetText(tweet);
        if (!id || !text) continue;

        if (seenTweetIds.has(id)) continue;
        seenTweetIds.add(id);

        if (seedOnly) {
          results.push({ username, id, status: "seeded" });
          continue;
        }

        const signal = computeSignal({ text, source: "TwitterAPI.io", author: username, externalId: id, createdAt: nowIso() });
        signal.url = getTweetUrl(tweet, username);

        if (!shouldAlert(signal)) {
          results.push({ username, id, status: "ignored_low_signal", score: signal.score });
          continue;
        }

        publish(signal);
        results.push({ username, id, status: "published", score: signal.score });
      }
    } catch (err) {
      console.error(`TwitterAPI.io polling failed for @${username}:`, err.message);
      results.push({ username, status: "error", error: err.message });
    }
  }

  return { status: "ok", results };
}

function startTwitterApiPolling() {
  if (!TWITTER_API_KEY) {
    console.log("TwitterAPI.io polling disabled: TWITTER_API_KEY not set.");
    return;
  }

  console.log(`TwitterAPI.io polling enabled. Accounts: ${MONITOR_X_ACCOUNTS.map((x) => "@" + x).join(", ")}`);
  console.log(`Polling interval: ${X_POLL_INTERVAL_SEC}s`);

  pollTwitterApiOnce({ seedOnly: true })
    .then((result) => {
      hasSeededInitialTweets = true;
      console.log("TwitterAPI.io initial seed complete:", JSON.stringify(result));
    })
    .catch((err) => console.error("TwitterAPI.io initial seed failed:", err.message));

  setInterval(() => {
    if (!hasSeededInitialTweets) return;
    pollTwitterApiOnce({ seedOnly: false }).catch((err) => {
      console.error("TwitterAPI.io interval polling failed:", err.message);
    });
  }, X_POLL_INTERVAL_SEC * 1000);
}

app.post("/api/check-x-now", async (req, res) => {
  const result = await pollTwitterApiOnce({ seedOnly: false });
  res.json(result);
});

async function startXStream() {
  const bearer = process.env.X_BEARER_TOKEN;
  if (!bearer) {
    console.log("Official X stream disabled: X_BEARER_TOKEN not set.");
    return;
  }
  console.log("Starting official X filtered stream listener...");
}

app.listen(PORT, () => {
  console.log(`Wall Street First Signal running on http://localhost:${PORT}`);
  startTwitterApiPolling();
  startXStream();
});
