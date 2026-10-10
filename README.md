# PoCW Engine — Proof of Cognitive Work

PoCW measures whether someone actually understood a piece of content. It ingests a source
(web page, whole book as PDF / EPUB / TXT / Markdown, or YouTube video), extracts a **knowledge graph** with an LLM, and then
runs an **adaptive test**: questions are generated from the graph (and checked before they are
shown), free-text answers are graded key point by key point, and a **4PL Item Response Theory**
model estimates the learner's ability.

The engine is a plain HTTP service (Node.js + TypeScript) backed by FalkorDB, Redis and SQLite.

---

## Architecture

```
                    ┌──────────────────────── engine (Express, :3000) ───────────────────────┐
  POST /api/index   │  parser ─▶ chunker ─▶ kg-builder (LLM) ─▶ kg-store ──────────────┐     │
  POST /api/upload  │  (SSRF-safe fetch, PDF, EPUB, HTML, YouTube)             FalkorDB │     │
                    │                                                                   ▼     │
  POST /api/verify  │  verify session ─▶ question generation (LLM, KG-grounded) + Jev check   │
  .../answer        │        │            ─▶ grading (Jev key points ▸ LLM; exact MCQ/TF)     │
  .../result        │        └─▶ irt-engine (4PL MAP θ, SE, concept-mastery loop)             │
                    │  content-store (SQLite: status, title, author)  session-store (Redis)   │
                    └──────────────────────────────────────────────────────────────────────────┘
```

| Component | Role |
|---|---|
| `src/services/parser.ts`, `safe-fetch.ts` | URL / upload / PDF / HTML / YouTube text extraction; every fetch is SSRF-guarded |
| `src/services/epub.ts`, `zip-reader.ts`, `book-text.ts` | EPUB parsing (hardened ZIP reader), Project Gutenberg stripping, title/author detection, text limits |
| `src/services/kg-builder.ts`, `kg-store.ts` | LLM knowledge-graph extraction (sampled across the whole text, merged across chunks); storage and queries in FalkorDB |
| `src/services/question-*.ts`, `answer-grading.ts` | Question generation + question check (Jev), answer grading (Jev + LLM escalation) |
| `src/services/ai-config.ts`, `llm-client.ts`, `decisions-client.ts` | Models/prompts (`AI_CONFIG_PATH`), OpenRouter chat calls (fallbacks, reasoning, cost), OpenRouter decisions API (Jev) |
| `src/services/usage-store.ts` | Call log in SQLite (model, tokens, cost, latency per call; 90 days) behind `GET /api/usage` |
| `src/services/irt-engine.ts` | 4PL IRT, MAP ability estimation, concept-mastery item selection |
| `src/sdk/` | `PoCW` SDK class (`index`, `verify`, admin ops), `VerifySession`, SQLite content store |
| `src/app.ts`, `src/server.ts` | HTTP API, auth, rate limiting, startup |
| `public/explore.html` | Developer explorer: index content, view the graph, run a session |

Internals (IRT model, mastery loop, grading, stopping rules): [docs/OPTIONS.md](docs/OPTIONS.md).
Full API reference: [docs/API.md](docs/API.md).

---

## Quick start (Docker)

```bash
cp .env.example .env
# set OPENROUTER_API_KEY, POCW_API_KEY, REDIS_PASSWORD, FALKORDB_PASSWORD
# (openssl rand -hex 32 for the secrets; keep them URL-safe)
docker compose up -d --build
curl http://127.0.0.1:3000/health
```

`docker-compose.yml` runs three services:

| Service | Image | Exposed |
|---|---|---|
| `falkordb` | `falkordb/falkordb:v4.20.7` | internal network only, password protected, `maxmemory` = `FALKORDB_MAXMEMORY` (512mb) |
| `redis` | `redis:7.4.11-alpine` | internal network only, password protected |
| `engine` | built from `Dockerfile` | `127.0.0.1:${ENGINE_PORT:-3000}` on the host |

### Running behind the landing app

The engine is meant to sit on a private Docker network behind a web front end that calls it
server-side. The compose file creates a network with the fixed name **`pocw`**; the landing
app's compose joins it as an external network and reaches the engine at `http://engine:3000`:

```yaml
# landing docker-compose.yml (separate repo)
services:
  web:
    environment:
      POCW_ENGINE_URL: http://engine:3000
      POCW_API_KEY: ${POCW_API_KEY}      # same value as the engine's
    networks: [pocw]
networks:
  pocw:
    external: true
```

FalkorDB and Redis are on a second, internal-only network (`pocw_backend`) that the landing
cannot reach. Start the engine stack first so the `pocw` network exists.

For per-client rate limiting, the landing should forward the client IP in `X-Forwarded-For` and
the engine should run with `TRUST_PROXY=1` (one proxy hop).

## Local development (without Docker for the engine)

```bash
npm ci
# FalkorDB + Redis reachable from the host, e.g.:
docker run -d --name pocw-falkordb-dev -p 127.0.0.1:6379:6379 falkordb/falkordb:v4.20.7
docker run -d --name pocw-redis-dev    -p 127.0.0.1:6380:6379 redis:7.4.11-alpine
cp .env.example .env                    # FALKORDB_HOST=localhost, REDIS_URL=redis://localhost:6380/1
npm run dev                             # ts-node-dev, http://localhost:3000/explore.html
```

If Redis is unreachable the engine exits with a single `[engine] FATAL: ...` line. If FalkorDB is
unreachable it starts in degraded mode (no graph extraction) and keeps retrying every 30 s.

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | — | LLM access (required for indexing and testing) |
| `POCW_API_KEY` | — | Bearer token for `/api/*`. Required when `NODE_ENV=production` |
| `ADMIN_API_KEY` | — | Bearer token for `/api/admin/*`. Unset ⇒ admin API returns 403 |
| `TRUST_PROXY` | off | Express `trust proxy`: hop count (`1`), `true`, or an address list |
| `ALLOW_MODEL_OVERRIDE` | off | `true` lets HTTP callers pick the LLM via `config.model`; otherwise it is ignored |
| `AI_CONFIG_PATH` | `ai-config.yml` | Models + prompts file (absolute, or relative to the working directory / project root). `ai-config.baseline.yml` = the pre-2026-10-10 setup |
| `CORS_ORIGIN` | — | Only needed if browsers call the engine directly |
| `PORT` | `3000` | HTTP port |
| `POCW_DB_PATH` | `./data/pocw.db` | SQLite content index |
| `FALKORDB_HOST` / `FALKORDB_PORT` / `FALKORDB_PASSWORD` / `FALKORDB_GRAPH` | `localhost` / `6379` / — / `pocw` | Graph store |
| `REDIS_URL` | `redis://localhost:6379/1` | Session store |
| `ENGINE_PORT`, `REDIS_PASSWORD`, `FALKORDB_MAXMEMORY`, `*_MEM_LIMIT` | see `.env.example` | docker-compose only |

### Models (`ai-config.yml`)

All calls go through OpenRouter (`OPENROUTER_API_KEY`). Models and prompts live in
[`ai-config.yml`](ai-config.yml) (or the file named by `AI_CONFIG_PATH`); the engine validates the
file at startup and logs which one it loaded.

| Task | Model | Reasoning | Fallback |
|---|---|---|---|
| Knowledge-graph extraction (`kg`) | `anthropic/claude-haiku-5.5` | low | `google/gemini-2.5-flash` |
| Question generation — open / MCQ / true-false (`question`) | `anthropic/claude-haiku-5.5` | off | `google/gemini-2.5-flash` |
| Question check, before a question is shown (`question_check`) | `typesafe/jev-1.13` (decisions API) | — | keep the question |
| Grading open answers (`grade`) | `typesafe/jev-1.13` (decisions API) | — | escalation ↓ |
| Grade escalation — Jev unsure / inconsistent / failed (`grade_escalation`) | `openai/gpt-6-luna` | low | `google/gemini-2.5-flash` |
| Titles of web pages / videos (`title`) | `openai/gpt-5-nano` | minimal (cannot be turned off) | fallback title from the page |

Requests send `"models": [primary, ...fallbacks]` (OpenRouter tries them in order),
`"reasoning": { "effort": … }` / `{ "enabled": false }`, and `"usage": { "include": true }` so
every response carries its cost. MCQ / true-false answers are graded without a model.

**Jev** (`typesafe/jev-1.13`) is a "System One" decisions model, not a chat model: it is called on
`POST https://openrouter.ai/api/alpha/decisions` with a context (`state`) and named `choice`
questions, and answers each with a choice, probabilities and a confidence in ~0.3 s for ~$0.00002–0.00008.
The engine uses it to check questions (is the MCQ / true-false key right? answerable from the passage? plainly
worded? about the work itself rather than its introduction? → regenerate once) and to grade open answers per key point (covered / partial / missing +
an overall verdict), escalating to the LLM grader when Jev is unsure (confidence < 0.6), when its
verdict and coverage disagree, or when the call fails. Details: [docs/OPTIONS.md §5, §7](docs/OPTIONS.md).

**Baseline / A-B.** [`ai-config.baseline.yml`](ai-config.baseline.yml) keeps the models and prompts
used before 2026-10-10 (all `google/gemini-2.5-flash`, no Jev, LLM-only grading). Roll back with
`cp ai-config.baseline.yml ai-config.yml`, or run a second engine with
`AI_CONFIG_PATH=ai-config.baseline.yml` to compare. (Code-level changes — the Analyze cap on Bloom
targets, the 50/50 true/false target and the cost log — apply to both.)

**Cost.** Every chat and decisions call is logged in the engine's SQLite database (task, model that
actually answered, tokens, `usage.cost`, latency, ok/error, resource / session; 90 days).
`GET /api/usage?days=30` (bearer `POCW_API_KEY`, server-to-server only) returns totals, per-day,
per-task/model, per indexed book and per finished test session, plus the live key balance.
A live smoke run (one Alice in Wonderland passage) cost ≈ $0.001 for one KG chunk (Haiku 5.5,
~7 s), ≈ $0.0003–0.0004 per generated question (~1.5 s) plus ≈ $0.00005 for its Jev check (~0.3 s),
≈ $0.00007 per Jev grade (~0.3 s), ≈ $0.0002 per GPT-6 Luna escalation (~2–3 s) and ≈ $0.00005 per
title (gpt-5-nano, ~1 s).

---

## API summary

All `/api/*` routes need `Authorization: Bearer $POCW_API_KEY` (when set). Rate limit: 30
requests/min per client IP; index-status polling has its own 120/min budget.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/upload` | Raw body (`application/pdf`, `application/epub+zip`, `text/*`, `application/octet-stream`, ≤ 40 MB) → index |
| `POST` | `/api/index` | `{ source: "https://..." }` → index a URL |
| `GET` | `/api/index` | List indexed content |
| `GET` | `/api/index/:knowledgeId` | Indexing status (`202` + `Retry-After` while pending/indexing), `title`, optional `author` |
| `PATCH` | `/api/index/:knowledgeId/title` | Re-derive or set a title |
| `POST` | `/api/verify` | `{ knowledgeId, subject?, config? }` → start a session, first question |
| `POST` | `/api/verify/:sessionId/answer` | `{ answer }` → feedback (+ `nextQuestion`); open answers add `keyPoints`, `modelAnswer`, `gradedBy` |
| `GET` | `/api/verify/:sessionId/result` | Final result (θ, score, `concepts[]`, profile, disclaimers) |
| `GET` | `/api/graph/:knowledgeId` | Knowledge graph `{ contentId, nodes, edges }` |
| `GET` | `/api/usage?days=30` | Model spend: live key balance, totals, by day, by task/model, per book, per session (operator, server-to-server only) |
| `GET`/`PATCH`/`DELETE`/`POST` | `/api/admin/...` | List (incl. hidden), visibility, delete, reindex, wipe — `Bearer $ADMIN_API_KEY` |
| `GET` | `/health` | Liveness (no auth) |

Details, shapes and error codes: [docs/API.md](docs/API.md).

### Sources, books and limits

| | |
|---|---|
| Formats | Web pages (HTML), PDF, EPUB 2/3, plain text, Markdown, YouTube captions — by URL (`/api/index`) or upload (`/api/upload`, not YouTube/HTML) |
| Upload size | ≤ 40 MB (`413` above); URL downloads ≤ 50 MB / 120 s, always through the SSRF guard |
| Text size | 4 000 000 characters per document (whole novels: Moby-Dick ≈ 1.2 M, War and Peace ≈ 3.2 M) |
| Project Gutenberg | License header/footer stripped; `Title:` / `Author:` used as metadata |
| Title / author | EPUB `dc:title` / `dc:creator`, PDF info `Title` / `Author` (placeholders ignored), Gutenberg header; else the usual title derivation. `author` is returned by `GET /api/index/:id` and in listings |
| Knowledge graph | Chunks sampled across the whole text (≤ 40 LLM calls, 4 in parallel), concepts merged across chunks, ≤ 50 nodes / 150 edges |
| EPUB safety | ZIP reader capped at 10 000 entries and 60 MB decompressed (enforced while inflating) |

---

## Tests

```bash
npm test          # mocha + tsx; no FalkorDB/Redis/network needed (LLM, decisions API, DNS and HTTP are stubbed)
npm run typecheck
npm run build
```

---

## Project layout

```
src/            engine source (app.ts, server.ts, sdk/, services/)
tests/          mocha tests
public/         explore.html developer UI
docs/           API.md, OPTIONS.md
ai-config.yml            models and prompts (AI_CONFIG_PATH selects another file)
ai-config.baseline.yml   models and prompts before 2026-10-10 (all gemini-2.5-flash) — rollback / A-B
Dockerfile, docker-compose.yml, .env.example
```
