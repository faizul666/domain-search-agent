# Domain Search Agent

An AI-assisted domain finder. Tell it about your business, answer a few questions, and it
**generates candidate names, verifies which `.com` domains are actually available to
register (live RDAP), and ranks them** with a weighted 1–10 scoring model.

The whole point: it only surfaces domains you can actually register.

- **AI name generation** — DeepSeek or Gemini (switchable)
- **Live `.com` availability** — RDAP, no API key
- **Trademark screen** — DeepSeek model-knowledge, or Gemini live web-grounded (Google Search)
- **Social handles** — GitHub (reliable) + best-effort X / Instagram / TikTok
- **Scoring** — Brandable, Short, Easy-spell, .com available, Trademark, Socials, Future-proof,
  Pronounce, SEO, Professional → normalized to /100 (85+ is strong)

---

## Quick start

### 1. Prerequisites
- [Node.js 18+](https://nodejs.org) (uses built-in `fetch`)
- An API key from **one** provider:
  - DeepSeek — <https://platform.deepseek.com/api_keys>
  - or Gemini — <https://aistudio.google.com/apikey>

### 2. Clone
```bash
git clone https://github.com/<your-username>/domain-search-agent.git
cd domain-search-agent
```

### 3. Add your API key
Copy the example env file and paste your own key into it:
```bash
cp .env.example .env
```
Then open `.env` and set the provider + key. For DeepSeek (default):
```
PROVIDER=deepseek
DEEPSEEK_API_KEY=sk-your-own-key-here
```
Or to use Gemini (enables live web-grounded trademark checks):
```
PROVIDER=gemini
GEMINI_API_KEY=your-own-gemini-key-here
```

> `.env` is gitignored — your key stays local and is never committed. Keys live only on the
> server; the browser never sees them.

### 4. Run
```bash
node server.js
```
Open <http://localhost:3000>. Visit `/api/health` to confirm the active provider and that your
key was detected.

---

## Using it

1. Fill in the business brand seed / description / keywords and the 5 questions.
2. **🎯 Find available .com** — the main flow. It generates names with your AI provider,
   RDAP-checks each, and repeats until it has your target number of registerable `.com` names,
   then scores just those.
3. Or **🤖 Generate with AI** to fill the candidate box, then **🚀 Score current list**.
4. Read the ranked table; filter to "available" and "85+".

---

## Switching provider

Set `PROVIDER` in `.env` and restart:

| `PROVIDER` | Name generation | Trademark check | Key it uses |
|---|---|---|---|
| `deepseek` (default) | DeepSeek | model-knowledge only (no live web) | `DEEPSEEK_API_KEY` |
| `gemini` | Gemini | **live web-grounded** (Google Search) | `GEMINI_API_KEY` |

You can keep both keys in `.env`; only the one matching `PROVIDER` is used.

---

## Configuration reference (`.env`)

| Variable | Purpose | Default |
|---|---|---|
| `PROVIDER` | `deepseek` or `gemini` | `deepseek` |
| `DEEPSEEK_API_KEY` | DeepSeek key (when `PROVIDER=deepseek`) | — |
| `DEEPSEEK_MODEL` | `deepseek-chat` or `deepseek-reasoner` | `deepseek-chat` |
| `GEMINI_API_KEY` | Gemini key (when `PROVIDER=gemini`) | — |
| `GEMINI_MODEL` | Gemini model id | `gemini-2.5-flash` |
| `PORT` | HTTP port | `3000` |
| `GITHUB_TOKEN` | Raises GitHub social-check rate limit | — |

---

## How it works

- **`server.js`** — a zero-dependency Node server. Serves the page and proxies the
  secret-key calls (`/api/generate`, `/api/trademark`, `/api/social`) so keys stay server-side.
  It auto-loads `.env`.
- **`index.html`** — the whole UI + scoring + RDAP availability (runs in the browser).
- Scoring: each criterion is rated 1–10 and weighted, then normalized —
  `Σ(score × weight) / Σ(weight) × 10`. **85+/100** is a strong domain.

## Limitations (be honest with yourself)

- **Trademark is informational, not legal advice.** Verify at
  [USPTO](https://tmsearch.uspto.gov) / [EUIPO](https://euipo.europa.eu) before committing.
  With DeepSeek it's a model-knowledge screen (can be stale); with Gemini it's a live web
  search (findable-on-the-web, not an official registry).
- **X / Instagram / TikTok** block automated checks, so those often read "unknown".
  **GitHub** is the reliable social signal.
- Availability is a live RDAP lookup; always confirm at a registrar before buying.

## No key? It still partly works
Open `index.html` with no server for **rule-based** name ideas + **RDAP `.com` availability** —
the AI generation and trademark/social checks are what need the backend + key.

## License

MIT
