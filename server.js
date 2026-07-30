/* ============================================================
   Domain Search Agent — backend proxy
   ------------------------------------------------------------
   Zero external dependencies (Node 18+ for built-in fetch).
   Keeps secret keys server-side and adds capabilities the
   browser can't do safely:
     POST /api/generate   -> DeepSeek creative name ideas
     GET  /api/social?q=  -> real handle checks (GitHub + best effort)
     GET  /api/trademark?q= -> USPTO lookup + heuristic fallback
   Static files (index.html etc.) are served from this folder.

   Run:  DEEPSEEK_API_KEY=xxxxx node server.js
   Then open http://localhost:3000
   ============================================================ */

const http = require("http");
const fs = require("fs");
const path = require("path");

/* Load .env (simple, no dependency) — sets process.env from KEY=value lines. */
(function loadEnv() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    /* no .env file — rely on real environment variables */
  }
})();

const PORT = process.env.PORT || 3000;

// Which LLM provider to use: "deepseek" or "gemini".
const PROVIDER = (process.env.PROVIDER || "deepseek").toLowerCase();

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE || "https://api.deepseek.com";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const isGemini = () => PROVIDER === "gemini";
const activeKeySet = () => (isGemini() ? !!GEMINI_API_KEY : !!DEEPSEEK_API_KEY);
const activeModel = () => (isGemini() ? GEMINI_MODEL : DEEPSEEK_MODEL);
const missingKeyMsg = () =>
  isGemini()
    ? "GEMINI_API_KEY is not set (PROVIDER=gemini)."
    : "DEEPSEEK_API_KEY is not set (PROVIDER=deepseek).";
// Optional: a GitHub token raises the social-check rate limit (60/hr -> 5000/hr).
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const UA = "Mozilla/5.0 (compatible; DomainSearchAgent/1.0)";

/* ---------------- helpers ---------------- */
const clamp = (n, a = 1, b = 10) => Math.max(a, Math.min(b, n));
const cleanWord = (s) => (s || "").toLowerCase().replace(/[^a-z0-9-]/g, "");

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) req.destroy(); // basic guard
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

/* ---------------- DeepSeek chat helper ---------------- */
// OpenAI-compatible chat completion returning parsed JSON content.
async function deepseekJSON(system, user, temperature) {
  if (!DEEPSEEK_API_KEY) return { error: "DEEPSEEK_API_KEY is not set on the server." };
  try {
    const r = await fetch(DEEPSEEK_BASE + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + DEEPSEEK_API_KEY,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: temperature ?? 1.0,
        response_format: { type: "json_object" },
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      return { error: `DeepSeek API ${r.status}: ${t.slice(0, 300)}` };
    }
    const j = await r.json();
    const text = j?.choices?.[0]?.message?.content || "{}";
    try {
      return { data: JSON.parse(text) };
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      return m ? { data: JSON.parse(m[0]) } : { error: "DeepSeek returned non-JSON." };
    }
  } catch (e) {
    return { error: "DeepSeek request failed: " + e.message };
  }
}

/* ---------------- Gemini helpers ---------------- */
function stripFences(t) {
  return (t || "").replace(/```(?:json)?/gi, "").trim();
}
// Returns { names: [...] } | { error }
async function geminiNames(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 1.0,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: { names: { type: "ARRAY", items: { type: "STRING" } } },
        required: ["names"],
      },
    },
  };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { error: `Gemini API ${r.status}: ${(await r.text()).slice(0, 300)}` };
    const j = await r.json();
    const text = j?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    try { return { names: JSON.parse(text).names || [] }; }
    catch { return { names: [] }; }
  } catch (e) {
    return { error: "Gemini request failed: " + e.message };
  }
}
// Live web-grounded trademark check. Returns result object | null.
async function geminiTrademark(word) {
  const prompt = `Search the web for existing companies, products, or registered trademarks named "${word}" (or very close variants). Assess how risky it would be to adopt "${word}" as a NEW business/brand/domain name.

Respond with ONLY a compact JSON object, no markdown:
{"risk": <integer 1-10, where 10 = clearly safe/no notable conflict, 1 = strong existing brand/trademark conflict>, "status": "clear" | "possible-conflict" | "high-risk", "notes": "<one short sentence>", "sources": ["<brand or company name>", ...]}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = { contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }] };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const parts = j?.candidates?.[0]?.content?.parts || [];
    const m = stripFences(parts.map((p) => p.text || "").join("")).match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    if (typeof parsed.risk !== "number") return null;
    return {
      risk: clamp(Math.round(parsed.risk)),
      status: parsed.status || "unknown",
      hits: Array.isArray(parsed.sources) && parsed.sources.length
        ? parsed.sources.slice(0, 5)
        : (parsed.notes ? [parsed.notes] : []),
      verified: !!j?.candidates?.[0]?.groundingMetadata, // true = backed by a real search
    };
  } catch {
    return null;
  }
}

/* ---------------- name generation (provider-aware) ---------------- */
async function generateNames(input) {
  if (!activeKeySet()) {
    return { error: missingKeyMsg(), names: [] };
  }
  const {
    brand = "",
    about = "",
    keywords = "",
    tone = "",
    styles = [],
    avoid = "",
    maxlen = 12,
    count = 30,
    exclude = [],
  } = input || {};

  const styleText = Array.isArray(styles) && styles.length ? styles.join(", ") : "invented/brandable";
  const excludeList = Array.isArray(exclude) ? exclude.slice(0, 400).map(cleanWord).filter(Boolean) : [];
  const excludeText = excludeList.length
    ? `\n\nDo NOT return any of these already-tried names (or trivial variants of them): ${excludeList.join(", ")}.`
    : "";

  const prompt = `You are a naming expert generating candidate domain names (the second-level part only, e.g. "brewnest" not "brewnest.com").

Business brand seed: ${brand || "(none — invent from keywords)"}
What the business does: ${about || "(not given)"}
Core keywords: ${keywords || "(none)"}
Audience & tone: ${tone || "(not specified)"}
Preferred naming styles: ${styleText}
Words to include/avoid: ${avoid || "(none)"}
Max length (characters): ${maxlen}

Rules:
- Return ${count} distinct candidate names, lowercase, letters only (no spaces, hyphens, numbers, or TLDs).
- Each name must be <= ${maxlen} characters and >= 3 characters.
- Favor short, brandable, easy-to-pronounce, easy-to-spell names.
- Mix the requested styles. Avoid trademarked brand names (Apple, Google, Nike, etc.) and anything in the "avoid" list.
- Prefer names likely to be available to register as a .com.${excludeText}
Respond with a JSON object of the form {"names": ["name1", "name2", ...]} and nothing else.`;

  let raw;
  if (isGemini()) {
    const g = await geminiNames(prompt);
    if (g.error) return { error: g.error, names: [] };
    raw = g.names;
  } else {
    const res = await deepseekJSON(
      "You are a branding and naming expert. Always respond with valid JSON only.",
      prompt,
      1.3, // higher temperature for creative variety
    );
    if (res.error) return { error: res.error, names: [] };
    raw = res.data?.names || [];
  }
  const names = raw.map(cleanWord).filter((w) => w.length >= 3 && w.length <= maxlen);
  return { names: [...new Set(names)] };
}

/* ---------------- Social handle checks ---------------- */
// Returns "available" | "taken" | "unknown"
async function checkGitHub(name) {
  try {
    const headers = { "User-Agent": UA, Accept: "application/vnd.github+json" };
    if (GITHUB_TOKEN) headers.Authorization = "Bearer " + GITHUB_TOKEN;
    const r = await fetch("https://api.github.com/users/" + encodeURIComponent(name), { headers });
    if (r.status === 404) return "available";
    if (r.status === 200) return "taken";
    return "unknown"; // 403 rate-limit etc.
  } catch {
    return "unknown";
  }
}

// Best-effort profile probe. These platforms actively block bots, so treat as approximate.
// trust200: some sites (Instagram, TikTok) return HTTP 200 login walls even for
// nonexistent profiles, so a 200 there means nothing — only a 404 is meaningful.
async function checkProfile(urlBase, name, trust200) {
  try {
    const r = await fetch(urlBase + encodeURIComponent(name), {
      method: "GET",
      headers: { "User-Agent": UA },
      redirect: "manual",
    });
    if (r.status === 404) return "available";
    if (r.status === 200) return trust200 ? "taken" : "unknown";
    return "unknown";
  } catch {
    return "unknown";
  }
}

async function checkSocial(name) {
  name = cleanWord(name).replace(/-/g, "");
  const [github, twitter, instagram, tiktok] = await Promise.all([
    checkGitHub(name),
    checkProfile("https://x.com/", name, true),
    checkProfile("https://www.instagram.com/", name, false),
    checkProfile("https://www.tiktok.com/@", name, false),
  ]);
  const platforms = { github, twitter, instagram, tiktok };

  // Score: GitHub is the reliable signal; others nudge. Unknown = neutral.
  let avail = 0,
    known = 0;
  const weigh = (v, w) => {
    if (v === "available") { avail += w; known += w; }
    else if (v === "taken") { known += w; }
  };
  weigh(github, 3); // reliable
  weigh(twitter, 1);
  weigh(instagram, 1);
  weigh(tiktok, 1);
  let score;
  if (known === 0) score = 6; // nothing conclusive -> neutral
  else score = clamp(3 + Math.round((avail / known) * 7));
  return { score, platforms, verified: github !== "unknown" };
}

/* ---------------- Trademark lookup ---------------- */
// Informational only, NOT legal advice.
// DeepSeek has no built-in web search, so this reflects the MODEL'S KNOWLEDGE of
// existing brands (can be stale/incomplete), plus a fast famous-mark guard.
async function deepseekTrademark(word) {
  if (!DEEPSEEK_API_KEY) return null;
  const prompt = `From your knowledge of existing companies, products, and registered trademarks, assess how risky it would be to adopt "${word}" (or very close variants) as a NEW business/brand/domain name.

Respond with a JSON object only:
{"risk": <integer 1-10, where 10 = no notable conflict you know of, 1 = strong existing brand/trademark conflict>, "status": "clear" | "possible-conflict" | "high-risk", "notes": "<one short sentence>", "sources": ["<known brand or company name>", ...]}`;
  const res = await deepseekJSON(
    "You are a trademark screening assistant. Respond with valid JSON only.",
    prompt,
    0.3,
  );
  if (res.error || typeof res.data?.risk !== "number") return null;
  const d = res.data;
  return {
    risk: clamp(Math.round(d.risk)),
    status: d.status || "unknown",
    hits: Array.isArray(d.sources) && d.sources.length
      ? d.sources.slice(0, 5)
      : (d.notes ? [d.notes] : []),
    // Not a live registry/web check — it's model knowledge, so mark unverified.
    verified: false,
  };
}
async function checkTrademark(name) {
  const word = cleanWord(name).replace(/-/g, "");
  // Obvious famous-mark guard first (fast, offline).
  const famous = ["apple", "google", "amazon", "nike", "coke", "cocacola", "disney",
    "meta", "tesla", "uber", "netflix", "paypal", "microsoft", "adidas", "starbucks"];
  if (famous.some((f) => word.includes(f))) {
    return { risk: 1, status: "high-risk", hits: ["matches a well-known brand"], verified: true };
  }

  // Provider check: Gemini = live web-grounded; DeepSeek = model knowledge.
  if (activeKeySet()) {
    const g = isGemini() ? await geminiTrademark(word) : await deepseekTrademark(word);
    if (g) return g;
  }

  // Fallback: unverified, neutral.
  return { risk: 7, status: "unverified", hits: ["lookup unavailable — verify at USPTO/EUIPO"], verified: false };
}

/* ---------------- static file serving ---------------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};
function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const filePath = path.join(__dirname, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

/* ---------------- router ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  if (url.pathname === "/api/generate" && req.method === "POST") {
    const input = await readBody(req);
    return sendJSON(res, 200, await generateNames(input));
  }
  if (url.pathname === "/api/social" && req.method === "GET") {
    const q = url.searchParams.get("q") || "";
    if (!q) return sendJSON(res, 400, { error: "missing q" });
    return sendJSON(res, 200, await checkSocial(q));
  }
  if (url.pathname === "/api/trademark" && req.method === "GET") {
    const q = url.searchParams.get("q") || "";
    if (!q) return sendJSON(res, 400, { error: "missing q" });
    return sendJSON(res, 200, await checkTrademark(q));
  }
  if (url.pathname === "/api/health") {
    return sendJSON(res, 200, {
      ok: true,
      provider: PROVIDER,
      model: activeModel(),
      keySet: activeKeySet(),
      groundedTrademark: isGemini(), // only Gemini does live web-grounded TM
    });
  }

  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Domain Search Agent running at http://localhost:${PORT}`);
  console.log(`  provider: ${PROVIDER}  model: ${activeModel()}  key: ${activeKeySet() ? "set" : "MISSING"}`);
  if (!activeKeySet()) console.log(`  -> ${missingKeyMsg()}`);
});
