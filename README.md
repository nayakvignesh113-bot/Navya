# Navya — Patent Engine

Prior-art search, patentability scoring, claim checking and claim rewriting for patent applications, plus a weekly **Opportunity Radar** of patentable ideas in mechanical engineering.

**Running cost: ₹0.** It runs on GitHub Pages, a Google Apps Script relay, a Google Sheet and Drive folder, a free Gemini API key, Google Patents and OpenAlex.

```
Browser (GitHub Pages)  ──►  Apps Script relay  ──►  Gemini API (free key)
  engine.js  (all scoring)        │                  Google Patents (search + full text)
  app.js     (UI, pipeline)       │                  OpenAlex (scientific papers)
                                  └──►  Sheet (users, reports index, radar)  +  Drive (report JSON)
```

## What it does

| Stage | How | Needs AI? |
|---|---|---|
| Read PDF / DOCX / TXT, find sections and claims, split claims into elements | engine.js | no |
| Formal checks: dependencies, antecedent basis, indefinite wording, references to drawings, support in the description, claim count | engine.js | no |
| Search queries | keywords from the spec (always) + AI-written queries (AI mode) | optional |
| Search | Google Patents (before your cut-off date), OpenAlex, optional Gemini web search | optional |
| Screening | TF-IDF cosine similarity | no |
| Element-by-reference mapping | AI with verbatim quotes checked against the document, run twice; **or** rule-based sentence matching | optional |
| Novelty, inventive step, patentability index | fixed formula (Method tab) | no |
| Sec. 3 / industrial applicability | AI screen with checked quotes, or keyword screen; changes the score only when you confirm it | optional |
| Claims Studio: fallback merges, formal fixes | engine.js | no |
| Claims Studio: AI rewrite (every added limitation must quote your description; checked), re-score | AI + engine | rewrite only |
| Opportunity Radar (weekly, Monday 06:00 IST) | OpenAlex + Gemini with Google Search + Google Patents check | yes |

## Setup (about 20 minutes)

### 1. Gemini key
Use your existing free key from https://aistudio.google.com/apikey (the one Lineage uses works).

### 2. OAuth client ID (Google sign-in)
Google Cloud Console → APIs & Services → Credentials → *Create OAuth client ID* → Web application.
Authorised JavaScript origins: `https://nayakvignesh113-bot.github.io`. Copy the client ID. You can reuse Lineage's client ID if you add the same origin.

### 3. Relay
1. https://script.google.com → New project → name it `navya-relay`.
2. Paste `relay/Code.gs` over the default file. Copy the settings from `relay/appsscript.json` into the project's manifest (Project Settings → *Show "appsscript.json" manifest file*), or leave the defaults.
3. Project Settings → Script properties:
   - `GEMINI_KEY` = your key
   - `OAUTH_CLIENT_ID` = from step 2
   - `OWNER_EMAILS` = `vignesh@mite.ac.in,nayak.vignesh113@gmail.com`
   - `AUTO_APPROVE_DOMAIN` = `mite.ac.in` (optional: students signing in with college accounts are approved automatically)
   - `RADAR_EMAIL` = `true` (optional: weekly digest by email)
   - `CONTACT_EMAIL` = your email (sent to OpenAlex)
   - `MODEL` (optional) — default `gemini-flash-latest`. Google renames models often; if calls fail with 404, set a current free-tier Flash model ID.
4. Run `setup` once and authorise. It creates the Sheet, the Drive folder and the weekly radar trigger.
5. Run `selfTest` and check the log. You should see an OK from Gemini plus Google Patents and OpenAlex results.
6. Deploy → New deployment → Web app → Execute as **Me**, Who has access **Anyone**. Copy the `/exec` URL.

### 4. Site
1. Put `RELAY_URL` and `OAUTH_CLIENT_ID` in `config.js`.
2. Create the repo `nayakvignesh113-bot/navya`, push `index.html`, `style.css`, `config.js`, `engine.js` and `app.js`, then turn on Pages (Settings → Pages → main / root).
3. Open `https://nayakvignesh113-bot.github.io/navya/`, sign in, and press **Run now** on the Radar tab to fill it the first time.

## Free-tier limits and how the app handles them
- Each approved user gets `STUDENT_DAILY_CALLS` (default 150) Gemini calls per day. One AI analysis with double-check and 8 references uses about 20 calls. You (owner) are unlimited, apart from Google's own free-tier caps.
- If Gemini hits a limit mid-run, the remaining references are mapped rule-based and the report says so.
- Google Patents' `xhr/query` endpoint is **unofficial**. If Google changes or rate-limits it, `gpSearch` fails. The run continues on OpenAlex, and the report's search depth drops accordingly.
- **Confidentiality:** Google may use free-tier Gemini inputs to improve its products. For an unfiled invention use **Rule-based** mode, which sends only search keywords to Google Patents and OpenAlex, or file a provisional application first.

## Why the score is not "AI opinion"
- Applicant, inventor and address lines are removed before any model sees the text.
- The model only answers whether this one document discloses this one element, and must quote it. Quotes not found in the document count as absent.
- Two runs with reversed order. The min/max of the two runs is reported as the band.
- The score itself is arithmetic: novelty = 1 − best single-reference coverage, inventive step = 1 − best two-reference coverage.
- The score is an **upper bound** given the search; search depth is reported next to it.

It is a screening tool. A registered patent agent should still review any filing.

## Files
```
index.html  style.css  config.js  engine.js  app.js   → GitHub Pages
relay/Code.gs  relay/appsscript.json                   → Apps Script
```
