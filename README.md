# PoCW Engine — Proof of Cognitive Work

PoCW measures whether someone actually understood a piece of content. It ingests a source
(web page, PDF, plain text or YouTube video), extracts a **knowledge graph** with an LLM, and then
runs an **adaptive test**: questions are generated from the graph, free-text answers are graded by an
LLM against reference claims, and a **4PL Item Response Theory** model estimates the learner's ability.

The engine is a plain HTTP service (Node.js + TypeScript) backed by FalkorDB, Redis and SQLite.

---

## Architecture

```
                    ┌──────────────────────── engine (Express, :3000) ───────────────────────┐
  POST /api/index   │  parser ─▶ chunker ─▶ kg-builder (LLM) ─▶ kg-store ──────────────┐     │
  POST /api/upload  │  (SSRF-safe fetch, PDF, HTML, YouTube)                   FalkorDB │     │
                    │                                                                   ▼     │
  POST /api/verify  │  verify session ─▶ question generation (LLM, KG-grounded)               │
  .../answer        │        │            ─▶ grading (claims for open, exact for MCQ/TF)      │
  .../result        │        └─▶ irt-engine (4PL MAP θ, SE, concept-mastery loop)             │
                    │  content-store (SQLite: index status, titles)   session-store (Redis)   │
                    └──────────────────────────────────────────────────────────────────────────┘
```

| Component | Role |
|---|---|
| `src/services/parser.ts`, `safe-fetch.ts` | URL / PDF / HTML / YouTube text extraction; every fetch is SSRF-guarded |
| `src/services/kg-builder.ts`, `kg-store.ts` | LLM knowledge-graph extraction; storage and queries in FalkorDB |
| `src/services/question-*.ts` | Question generation + quality check, answer grading |
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
| `CORS_ORIGIN` | — | Only needed if browsers call the engine directly |
| `PORT` | `3000` | HTTP port |
| `POCW_DB_PATH` | `./data/pocw.db` | SQLite content index |
| `FALKORDB_HOST` / `FALKORDB_PORT` / `FALKORDB_PASSWORD` / `FALKORDB_GRAPH` | `localhost` / `6379` / — / `pocw` | Graph store |
| `REDIS_URL` | `redis://localhost:6379/1` | Session store |
| `ENGINE_PORT`, `REDIS_PASSWORD`, `FALKORDB_MAXMEMORY`, `*_MEM_LIMIT` | see `.env.example` | docker-compose only |

LLM models and prompts live in [`ai-config.yml`](ai-config.yml).

---

## API summary

All `/api/*` routes need `Authorization: Bearer $POCW_API_KEY` (when set). Rate limit: 30
requests/min per client IP; index-status polling has its own 120/min budget.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/upload` | Raw body (`application/pdf`, `text/*`, `application/octet-stream`, ≤ 10 MB) → index |
| `POST` | `/api/index` | `{ source: "https://..." }` → index a URL |
| `GET` | `/api/index` | List indexed content |
| `GET` | `/api/index/:knowledgeId` | Indexing status (`202` + `Retry-After` while pending/indexing) |
| `PATCH` | `/api/index/:knowledgeId/title` | Re-derive or set a title |
| `POST` | `/api/verify` | `{ knowledgeId, subject?, config? }` → start a session, first question |
| `POST` | `/api/verify/:sessionId/answer` | `{ answer }` → feedback (+ `nextQuestion`) |
| `GET` | `/api/verify/:sessionId/result` | Final result (θ, score, `concepts[]`, profile, disclaimers) |
| `GET` | `/api/graph/:knowledgeId` | Knowledge graph `{ contentId, nodes, edges }` |
| `GET`/`PATCH`/`DELETE`/`POST` | `/api/admin/...` | List (incl. hidden), visibility, delete, reindex, wipe — `Bearer $ADMIN_API_KEY` |
| `GET` | `/health` | Liveness (no auth) |

Details, shapes and error codes: [docs/API.md](docs/API.md).

---

## Tests

```bash
npm test          # mocha + tsx; no FalkorDB/Redis/network needed (LLM, DNS and HTTP are stubbed)
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
ai-config.yml   LLM models and prompts
Dockerfile, docker-compose.yml, .env.example
```
