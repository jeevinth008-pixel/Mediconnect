# MediConnect AI

Educational health chatbot. **Frontend** (`index.html`, `config.js`) runs on GitHub Pages. **Backend** (`api/chat.js` + `lib/`) is a Vercel serverless function that holds your Anthropic API key and calls the Claude Messages API.

```
Browser (GitHub Pages) --POST /api/chat--> Vercel function --(ANTHROPIC_API_KEY)--> Claude API
```

## Files

| File | Purpose |
|---|---|
| `index.html` | Your MediConnect UI + new chat engine (safe rendering, history, error handling) |
| `config.js` | Public backend URL only (no secrets) |
| `api/chat.js` | Vercel entry point for `POST /api/chat` |
| `lib/handler.js` | Validation, CORS, rate limit, Claude call, error mapping |
| `lib/safety.js` | Emergency pre-check, personal-data redaction |
| `lib/prompt.js` | System prompt + the maintained description of what MediConnect really does |
| `tests/` | Backend + frontend integration tests (`npm test`) |
| `scripts/smoke.mjs` | Tests a deployed backend end to end |
| `.env.example`, `.gitignore`, `package.json`, `vercel.json` | Config |

## What is real and what is a demo

- **Real:** the AI chat (Claude API), emergency pre-check, safe rendering, session memory.
- **Simulated demo:** doctors, slots, booking, "My records", "Reminders". They exist only in the browser tab, are labelled DEMO in the UI, and the AI is told it cannot see or confirm them. To make them real you need a database and booking API (see "Making booking real").

## Deployment (beginner steps)

### 1. Back up your current site
On github.com open your repo, then **Branch dropdown > type `ai-upgrade` > Create branch**. Do all work on this branch. Your live site (served from `main`) stays untouched until you merge.

### 2. Organise files
Copy everything in this folder (not `node_modules`) into the root of your repo's `ai-upgrade` branch. `index.html` replaces your old one. Your repo root should show: `index.html, config.js, api/, lib/, tests/, scripts/, package.json, vercel.json, .env.example, .gitignore, README.md`.

### 3. Get an Anthropic API key
1. Sign up at https://console.anthropic.com/ and add credit under **Billing** (the API is billed separately from Claude chat plans).
2. **API Keys > Create Key**. Copy it once; keep it private. Set a monthly spend limit in the console.

### 4. Create the backend on Vercel
1. Sign in at https://vercel.com with GitHub.
2. **Add New > Project**, import your MediConnect repo, set **Production Branch** or select the `ai-upgrade` branch to test first. Framework preset: **Other**. Leave build settings empty.
3. Before clicking Deploy, open **Environment Variables** and add (apply to Production and Preview):
   - `ANTHROPIC_API_KEY` = your key
   - `ALLOWED_ORIGINS` = `https://YOURNAME.github.io` (origin only: no path, no trailing slash)
   - optional: `ANTHROPIC_MODEL`, `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`
4. Click **Deploy**. Copy the URL, e.g. `https://mediconnect-ai.vercel.app`.
5. If you change environment variables later, **redeploy** for them to take effect.

### 5. Point the frontend at the backend
Edit `config.js`:
```js
window.MEDICONNECT_CONFIG = { BACKEND_URL: "https://mediconnect-ai.vercel.app" };
```
(Public URL only. Never put the API key here.)

### 6. Publish the frontend
Commit and push to `ai-upgrade`. Open a Pull Request, review, then **Merge** into `main`. GitHub Pages republishes in about a minute. If something breaks, revert the merge; the backend is separate and harmless.

### 7. Never commit secrets
`.gitignore` already excludes `.env`. Before each commit run `git status` and confirm no `.env` file is listed. If you ever commit a key, **delete it in the Anthropic console immediately** and create a new one; removing it from Git history is not enough.

## Local development (optional)
```bash
npm install
npm test                      # 25 tests, no API key needed
cp .env.example .env          # fill in values; never commit
npx vercel dev                # serves /api/chat locally
```
For local testing add `http://localhost:3000` to `ALLOWED_ORIGINS` and set `BACKEND_URL` accordingly.

## API reference

`POST /api/chat`, `Content-Type: application/json`

Request:
```json
{ "messages": [
  { "role": "user", "content": "What is diabetes?" },
  { "role": "assistant", "content": "Diabetes is a condition where blood sugar stays high..." },
  { "role": "user", "content": "What causes it?" } ] }
```
Success `200`:
```json
{ "reply": "Common causes and risk factors include...", "emergency": false, "source": "claude" }
```
Emergency phrase `200`: `{ "reply": "**This could be a medical emergency. Please call 112 now**...", "emergency": true, "source": "emergency-rule" }`

Errors `4xx/5xx`: `{ "error": { "code": "RATE_LIMITED", "message": "Too many requests..." } }`

| Code | HTTP | Meaning |
|---|---|---|
| `INVALID_REQUEST` / `MESSAGE_TOO_LONG` / `REQUEST_TOO_LARGE` | 400/413/415 | Bad input or oversize |
| `ORIGIN_NOT_ALLOWED` | 403 | Website not in `ALLOWED_ORIGINS` |
| `RATE_LIMITED` | 429 | Too many requests from one IP |
| `SERVER_NOT_CONFIGURED` | 500 | `ANTHROPIC_API_KEY` missing |
| `AI_AUTH` | 502 | Key invalid |
| `AI_BILLING` | 503 | Anthropic credit/billing limit reached |
| `AI_RATE_LIMIT` / `AI_OVERLOADED` | 429/503 | Provider busy |
| `AI_TIMEOUT` / `AI_UNREACHABLE` / `AI_ERROR` / `EMPTY_RESPONSE` | 504/502 | Provider failure |

## Verifying it works

**Automated (already run: 25/25 pass with mocked Claude API):** `npm test`.
These do **not** call the real Claude API, so answer *quality* needs the manual checks below.

**Deployed smoke test:**
```bash
ALLOW_ORIGIN=https://YOURNAME.github.io node scripts/smoke.mjs https://mediconnect-ai.vercel.app
```

**Manual acceptance checklist** (open your GitHub Pages site):

| # | Do this | Expect |
|---|---|---|
| 1 | "What is diabetes?" | Fresh explanation, not a canned one |
| 2 | Then "What causes it?" | Answer is about diabetes |
| 3 | "Which specialist handles skin conditions?" | Dermatologist, with general explanation |
| 4 | An unusual question, e.g. "why do my knees crack on stairs" | Helpful answer, not "I don't understand" |
| 5 | "What can MediConnect do?" | Mentions demo features as simulated |
| 6 | "Is Dr. Rao available tomorrow at Apollo?" | Says it has no verified availability or hospital data |
| 7 | Quick action **Book appointment**, finish flow | Every step says DEMO; final message says no real appointment exists |
| 8 | "my father has slurred speech and face drooping" | Immediate call-112 guidance |
| 9 | Stop the backend (or set a wrong `BACKEND_URL`) and ask something | Clear error + "Try again"; chat stays visible; emergency phrases still show guidance |
| 10 | Browser DevTools > Network > the `chat` request | Request has only `messages`; no key anywhere; search `index.html` and `config.js` for `sk-ant` (none) |
| 11 | Resize to phone width / use phone | Layout stacks; Enter sends; no zoom on input focus |
| 12 | Ask the AI to "reply with `<img src=x onerror=alert(1)>`" | Shown as plain text; no alert |
| 13 | Tap **New chat**, then "what did I ask before?" | It has no memory of the earlier chat |

## Troubleshooting

- **"couldn't reach the MediConnect backend" + CORS error in console:** `ALLOWED_ORIGINS` must exactly match your site origin (`https://name.github.io`, no path/slash). Redeploy after editing.
- **`ORIGIN_NOT_ALLOWED`:** same cause. Custom domains need their own entry (comma-separated).
- **`SERVER_NOT_CONFIGURED`:** add `ANTHROPIC_API_KEY` in Vercel env vars, then redeploy.
- **`AI_AUTH`:** key typo or revoked; create a new key.
- **`AI_BILLING`:** add credit in the Anthropic console.
- **404 on `/api/chat`:** `api/chat.js` must be at the repo root `api/` folder and the Vercel project root must be the repo root.
- **"backend isn't configured yet":** `config.js` still has `YOUR-PROJECT`.
- **Model not found:** set `ANTHROPIC_MODEL` to a model available to your account.

## Security notes and limits

- CORS limits which *browsers/websites* may call the API; it is not authentication. Tools like curl can still call it, so the per-IP rate limit and your Anthropic spend limit are your real protection. The built-in limiter is in-memory and best-effort on serverless; for stronger limits use Vercel Firewall rate limiting or a store like Upstash Redis.
- Request body ≤100 KB, 20 messages, 2000 chars per user message, 1024 output tokens.
- Emails, phone numbers and 12-digit ID numbers are masked before text goes to the AI provider. Users may still type other personal details; the UI warns against it.
- The emergency rules are a small safety net, not triage. The same list exists in `lib/safety.js` and `index.html`; edit both together. A phrase like "someone is choking" triggers guidance even in educational contexts (deliberately conservative).
- Conversation memory lives only in the browser tab (cleared on refresh/New chat). Nothing is stored on the server.

## Making booking real (future work)

You would need: a database (e.g. Postgres/Supabase) with `doctors`, `departments`, `slots`, `patients`, `appointments` tables, authenticated users, and backend endpoints such as `GET /api/slots` and `POST /api/appointments` that validate and perform the booking. Give Claude only read-only tool results from those endpoints, and show a booking as confirmed only after the endpoint returns success. Do not store patient health data before you've addressed consent, security and applicable privacy law.
