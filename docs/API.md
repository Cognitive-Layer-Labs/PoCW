# PoCW Engine — API Reference

- [HTTP API](#http-api) — what the landing app (or any server-side client) calls
- [SDK](#sdk) — using the engine in-process from TypeScript
- [Types](#types) · [Errors](#errors)

---

## HTTP API

### Conventions

- **Auth.** Every `/api/*` route requires `Authorization: Bearer <POCW_API_KEY>` when the key is
  configured (always in production). `/api/admin/*` requires `Authorization: Bearer <ADMIN_API_KEY>`
  instead; when `ADMIN_API_KEY` is unset the admin API answers `403`. Keys are compared in constant time.
- **Errors** are JSON: `{ "error": "<message>", "code": "<CODE>" }` (see [Errors](#errors)).
- **Rate limit.** 30 requests/min per client IP (`429`, code `CAPACITY_EXCEEDED`, standard
  `RateLimit-*` headers). `GET /api/index/:knowledgeId` (status polling) is exempt from that budget
  and has its own limit of 120/min. `/health` is not limited. Behind a proxy, set `TRUST_PROXY` so the
  client IP is taken from `X-Forwarded-For`.
- **Body size.** JSON bodies ≤ 1 MB; uploads ≤ 40 MB (`413` otherwise). URL sources are downloaded
  up to 50 MB (120 s).
- **Text size.** Each document is cut to **4 000 000 characters** after boilerplate removal — whole
  novels fit (Moby-Dick ≈ 1.2 M, War and Peace ≈ 3.2 M characters).

### Index status values

`status` is one of **`"pending"`**, **`"indexing"`**, **`"ready"`**, **`"failed"`**.

Indexing endpoints answer **`202` + `Retry-After: 5`** while the status is `pending` or `indexing`,
and **`200`** once it is terminal (`ready`, or `failed` with an `error` message). Re-submitting a
source whose indexing `failed` retries it.

---

### `POST /api/upload`

Index an uploaded file — an article or a whole book (PDF, EPUB, TXT, MD; ≤ 40 MB). Raw request
body (not multipart).

| `Content-Type` | Handling |
|---|---|
| `application/epub+zip` | EPUB 2/3: spine documents in reading order → text, chapters separated by a blank line; navigation/TOC, scripts and styles skipped. Title/author from the package metadata (`dc:title`, `dc:creator`). `422` if it is not a valid EPUB or has no text |
| `application/pdf` | text extracted with pdf-parse (`422` if the PDF has no text layer). Title/author from the document info when meaningful (placeholders such as "Untitled" or "Microsoft Word - …" are ignored) |
| `text/*` | decoded as UTF-8; `text/markdown` kept verbatim, other text re-flowed (paragraphs kept, hard line wraps joined) |
| `application/octet-stream` | EPUB if the body is a ZIP whose `mimetype` entry is `application/epub+zip`, PDF if it starts with `%PDF-`, otherwise UTF-8 text (`415` if binary) |

For every format, **Project Gutenberg** license text (everything before `*** START OF THE PROJECT
GUTENBERG EBOOK … ***` and from `*** END OF …` on) is removed and its `Title:` / `Author:` header
lines are used as metadata. EPUB archives are read with a hardened ZIP reader (≤ 10 000 entries,
≤ 60 MB decompressed in total, enforced while inflating).

The body is always indexed as **text** — it is never interpreted as a URL or path. The same text
always maps to the same `knowledgeId`.

**Response** `200` (already indexed) or `202` + `Retry-After` (indexing started):

```json
{ "knowledgeId": "3f5a…", "status": "indexing", "contentId": 182736451234 }
```

Other responses: `400` empty body, `415` unsupported content type / binary file, `422` unreadable
PDF/EPUB, `413` > 40 MB.

**Indexing a book.** The knowledge graph is extracted from chunks (4 000 characters) sampled
evenly across the whole text: all chunks for short texts (≤ 15), otherwise 2·√(chunks), at most
**40** LLM calls, **4** in parallel — a novel indexes in roughly 1–2 minutes. Concepts from all
chunks are merged (same or near-same labels: case, accents, articles, possessives, plurals and
parentheticals ignored) into one graph of at most **50** nodes (the most important) and 150 edges
between them.

---

### `POST /api/index`

Index a web page, a PDF / EPUB / text / Markdown file URL (e.g. a Project Gutenberg book), or a
YouTube video (captions). EPUB is recognised by `Content-Type: application/epub+zip`, a `.epub`
path, or an `application/octet-stream` / zip body that is an EPUB. Same parsing, limits and
metadata detection as `/api/upload`.

```json
{ "source": "https://en.wikipedia.org/wiki/Photosynthesis" }
```

`source` must be an `http://` or `https://` URL (`400` otherwise). URLs that are, resolve to, or
redirect to private/internal addresses (loopback, RFC 1918, link-local/metadata, CGNAT, Docker service
names, …) fail indexing with an `SSRF blocked` error.

**Response:** same shape and status codes as `/api/upload`.

---

### `GET /api/index`

List indexed content (hidden entries excluded). Query: `status?`, `limit?` (default 50, max 200), `offset?`.

```json
{
  "rows": [
    {
      "knowledge_id": "3f5a…", "content_type": "url", "source": "https://…",
      "title": "Photosynthesis", "description": "Photosynthesis is…",
      "status": "ready", "error": null, "content_id": 182736451234,
      "content_hash": "…", "chunk_count": 12, "created_at": "2026-10-10 10:00:00",
      "indexed_at": "2026-10-10 10:01:10", "usage_count": 3, "last_used_at": "…", "hidden": 0,
      "author": null
    }
  ],
  "total": 1
}
```

For uploaded text (`content_type: "raw_text"`), `source` is truncated to 300 characters.
`author` is the detected book author (EPUB `dc:creator`, PDF info `Author`, Project Gutenberg
`Author:` header) or `null`, without life dates or "active …" qualifiers ("Carroll, Lewis,
1832-1898" → "Lewis Carroll"; Gutenberg's "active 6th century B.C. Sunzi" → "Sunzi").

---

### `GET /api/index/:knowledgeId`

Indexing status. `202` + `Retry-After: 5` while `pending`/`indexing`, `200` when `ready`/`failed`,
`404` (`CONTENT_NOT_FOUND`) for unknown ids. Poll every ~5 s.

```json
{
  "knowledgeId": "3f5a…",
  "status": "ready",
  "contentId": 182736451234,
  "title": "Photosynthesis",
  "source": "https://en.wikipedia.org/wiki/Photosynthesis"
}
```

`error` is present when `status` is `"failed"`. `source` is only returned for URL sources.
`author` (optional string) is present when an author was detected — e.g.
`{ "title": "Moby-Dick; or The Whale", "author": "Herman Melville", … }`. For books the title is
taken from the file (EPUB `dc:title`, PDF info `Title`, Gutenberg `Title:`) before falling back to
the usual derivation (web page title via LLM, first line of text).

---

### `GET /api/index/:knowledgeId/text`

The full extracted text the graph and questions are built from, as `text/plain; charset=utf-8`
(Gutenberg licence stripped, up to 4,000,000 characters). Uploads return the stored text; URL
sources are re-fetched when not cached. `404` (`CONTENT_NOT_FOUND`) for unknown ids. Meant for
operators (e.g. an admin "download material" button) — don't expose it to untrusted clients.

---

### `PATCH /api/index/:knowledgeId/title`

Body `{ "title": "Custom title" }` stores a title; with no body the title is re-derived from a URL
source (YouTube oEmbed or LLM). Response: `{ "knowledgeId": "…", "title": "…" }`.

---

### `POST /api/verify`

Start an adaptive test session.

```json
{
  "knowledgeId": "3f5a…",
  "subject": "learner-42",
  "config": { "difficulty_preset": "medium", "q_types": ["open", "mcq", "true_false"], "response": "detailed" }
}
```

- `knowledgeId` — required; content must be `ready` (`202` `INDEXING_IN_PROGRESS` while indexing,
  `422` `INDEXING_FAILED`, `404` `CONTENT_NOT_FOUND`).
- `subject` — optional free-form learner label (≤ 200 chars), echoed in the result. Default `"anonymous"`.
- `config` — optional [`PoCWConfig`](#pocwconfig).

**Response 200:**

```json
{
  "sessionId": "0b6c2f7e-…",
  "question": {
    "text": "Which molecule is split during the light-dependent reactions?",
    "number": 1,
    "type": "mcq",
    "bloomLevel": "Understand",
    "difficulty": -0.4,
    "totalQuestions": 15,
    "options": ["Glucose", "Water", "Carbon dioxide", "ATP"]
  },
  "importantConceptCount": 9,
  "maxQuestions": 15
}
```

`question.options` is present for `mcq` only. Answer MCQs with the option letter (`"B"`) or text
prefix; true/false with `true`/`false` (`t`, `f`, `yes`, `no` accepted). Sessions live 30 minutes
in Redis, refreshed on every answer.

---

### `POST /api/verify/:sessionId/answer`

```json
{ "answer": "B" }
```

`answer`: 1–50 000 characters.

**Response 200** ([`AnswerFeedback`](#answerfeedback), plus `nextQuestion` while the session continues):

```json
{
  "correct": true,
  "score": 100,
  "reasoning": "Correct answer selected.",
  "irtParams": { "a": 2.1, "b": -0.4, "c": 0.25, "d": 1, "importance": 0.8, "theta_before": 0 },
  "correctAnswer": "B",
  "progress": { "questionNumber": 1, "theta": 0.62, "se": 0.91, "bloomLevel": "Apply" },
  "isComplete": false,
  "nextQuestion": { "text": "…", "number": 2, "type": "open", "bloomLevel": "Apply", "difficulty": 0.6, "totalQuestions": 15 }
}
```

Open questions return, instead of `correctAnswer`:

```json
{
  "correct": true,
  "score": 83,
  "reasoning": "You covered 2 of 3 key points, and 1 more partly.",
  "keyPoints": [
    { "point": "The Hatter quarrelled with Time", "status": "covered" },
    { "point": "Since then Time keeps it at six o'clock", "status": "covered" },
    { "point": "Six o'clock is tea-time, so tea never ends", "status": "partial" }
  ],
  "modelAnswer": "The Hatter quarrelled with Time, so Time stopped at six o'clock. It is always tea-time now.",
  "gradedBy": "jev",
  "referenceKeyPoints": ["The Hatter quarrelled with Time", "…", "…"],
  "dimensions": { "covered_points": 2.5, "total_points": 3, "precision_cap": 100 }
}
```

- `keyPoints` — each reference key point with `"covered" | "partial" | "missing"`.
- `modelAnswer` — a short complete answer (1–3 sentences) written with the question.
- `gradedBy` — `"jev"` (decisions model) or `"llm"` (LLM grader / escalation); for admin/debug.
- `reasoning` — a short sentence derived from `keyPoints`.
- Score: `round(100 × Σ(covered 1, partial ½) / n)`, capped at 40 when the overall verdict is
  "wrong"; `correct` = score ≥ 70 (see [OPTIONS.md §7](OPTIONS.md#7-open-question-grading-jev--llm-escalation)).

All three new fields are optional (absent for MCQ / true-false, and `keyPoints` is absent when a
legacy grader prompt is configured). When `isComplete` is `true`, `nextQuestion` is absent — fetch
the result.

Errors: `404` `SESSION_EXPIRED` (unknown/expired session), `409` `SESSION_NOT_ACTIVE` (already
complete), `409` `SESSION_BUSY` (another answer for this session is still being graded — one at a
time), `503` `LLM_ERROR` (generation/grading failed — the answer was not recorded; retry the same answer).

---

### `GET /api/verify/:sessionId/result`

Final result of a completed session (`409` `SESSION_NOT_ACTIVE` before that). The result is computed
once and frozen: repeated calls within the session lifetime return the same body.

```json
{
  "competenceIndicator": true,
  "score": 74,
  "theta": 0.96,
  "se": 0.38,
  "converged": true,
  "confidence_interval": [55, 93],
  "questions_asked": 11,
  "response_detail": [
    {
      "question": "Which molecule is split…", "type": "mcq", "score": 100,
      "difficulty": -0.4, "bloomLevel": "Understand", "correct": true,
      "conceptId": "light_dependent_reactions"
    }
  ],
  "concepts": [
    { "id": "light_dependent_reactions", "label": "Light-dependent reactions", "asked": 2, "correct": 1, "mastered": true },
    { "id": "calvin_cycle", "label": "Calvin cycle", "asked": 0, "correct": 0, "mastered": false }
  ],
  "profile": {
    "title": "Photosynthesis",
    "source": "https://en.wikipedia.org/wiki/Photosynthesis",
    "bloomLevelsReached": ["Understand", "Apply"],
    "bloomCoverage": { "Understand": 4, "Apply": 5, "Analyze": 2 },
    "aberrant": false,
    "questionTypes": ["mcq", "open", "true_false"]
  },
  "knowledgeId": "3f5a…",
  "contentId": 182736451234,
  "subject": "learner-42",
  "timestamp": "2026-10-10T10:12:00.000Z",
  "disclaimers": { "irtCalibration": "…", "bloomMapping": "…", "thresholdSemantics": "…" }
}
```

- `concepts` — **always present** (possibly empty): one entry per important KG concept tracked by the
  session, in descending importance, label from the KG node. `asked`/`correct` count questions tied to
  the concept; `mastered` reflects the concept-mastery loop.
- `response_detail` — only when `config.response = "detailed"`. Each entry's `conceptId` is the KG
  concept id the question targeted, or `null` if it could not be tied to a tracked concept.
- `score` = `round((clamp(θ, −2, 2) + 2) / 4 × 100)`; `competenceIndicator` = `score ≥ threshold × 100`.

---

### `GET /api/graph/:knowledgeId`

Knowledge graph of indexed content (also accepts the numeric `contentId`). `503` `GRAPH_DB_ERROR`
when FalkorDB is unavailable.

```json
{
  "contentId": 182736451234,
  "nodes": [{ "id": "calvin_cycle", "label": "Calvin cycle", "bloomLevel": "Understand", "importance": 0.71 }],
  "edges": [{ "source": "light_dependent_reactions", "target": "calvin_cycle", "relationship": "supplies_atp_to" }]
}
```

`importance` is normalised to [0, 1].

---

### `GET /api/usage`

Operator endpoint: model spend from the engine's call log (every chat and decisions call is
recorded with the model that actually answered, tokens, `usage.cost`, latency, ok/error and the
resource / session it belongs to; kept 90 days). `Authorization: Bearer <POCW_API_KEY>` like every
`/api` route — call it **server-to-server only**, never proxy it to browsers.

Query: `days` (1–90, default 30) — the last `days` UTC calendar days including today.

```json
{
  "days": 30,
  "key": { "limitUsd": 6, "usageUsd": 1.32, "remainingUsd": 4.68 },
  "totals": { "calls": 1240, "costUsd": 0.8123, "errors": 3 },
  "byDay": [{ "date": "2026-10-10", "calls": 120, "costUsd": 0.071 }],
  "byTask": [
    { "task": "kg", "model": "anthropic/claude-haiku-5.5", "calls": 300, "costUsd": 0.31, "avgLatencyMs": 6900, "errors": 1 },
    { "task": "grade", "model": "typesafe/jev-1.13-20260917", "calls": 210, "costUsd": 0.011, "avgLatencyMs": 320, "errors": 0 }
  ],
  "perBook": { "avgCostUsd": 0.021, "count": 14 },
  "perSession": { "avgCostUsd": 0.0068, "count": 37 },
  "quality": {
    "questionCheck": { "checked": 400, "passed": 371, "regenerated": 29, "reasons": { "not_plain": 18, "key_mismatch": 7, "not_answerable": 6 } },
    "grading": { "jev": 160, "escalated": 50, "reasons": { "low_confidence": 41, "disagreement": 6, "jev_error": 3 } }
  }
}
```

- `key` — live from OpenRouter `GET /api/v1/auth/key` (cached ~60 s); `limitUsd` / `remainingUsd`
  are `null` for an unlimited key; `key` is `null` when the lookup fails.
- `byDay` has one entry per day (zeros included), oldest first.
- `byTask` groups by `task` (`kg`, `question`, `question_check`, `grade`, `grade_escalation`,
  `title`, …) and the model that answered (fallbacks show up as their own rows), most expensive first.
- `perBook` — indexing cost per resource (calls tied to a resource outside any test session).
- `perSession` — generation + checking + grading cost per **finished** test session.
- `quality` (extra) — outcomes of the decisions-model steps: how often the question check passed
  or forced a regeneration (and why), and how often Jev's grade stood vs. was escalated (and why).

---

### Admin — `Authorization: Bearer <ADMIN_API_KEY>`

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/api/admin/content` | — (query `status?`, `limit?` ≤ 500, `offset?`) | `{ rows, total }` including hidden entries |
| `PATCH` | `/api/admin/content/:knowledgeId/visibility` | `{ "hidden": true }` | `{ knowledgeId, hidden }` |
| `DELETE` | `/api/admin/content/:knowledgeId` | — | `{ deleted: true, knowledgeId, contentId, nodesDeleted }` |
| `POST` | `/api/admin/content/:knowledgeId/reindex` | — | `202` + `Retry-After`, `{ knowledgeId, status: "indexing", contentId }` |
| `POST` | `/api/admin/wipe` | — | `{ wiped: true, contentRemoved, nodesRemoved }` |

`403` `FORBIDDEN` when the admin API is disabled, `401` `UNAUTHORIZED` on a wrong key.

---

### `GET /health`

No auth, not rate-limited. `200 { "status": "ok", "falkordb": true }` (`falkordb: false` while
running degraded).

---

## SDK

```ts
import { PoCW } from "./src/sdk";

const pocw = new PoCW({ dbPath: "./data/pocw.db" });
await pocw.init();                       // FalkorDB + SQLite (env: FALKORDB_*, see README)

const { knowledgeId } = await pocw.index("https://en.wikipedia.org/wiki/Photosynthesis");
await pocw.waitForIndex(knowledgeId);    // throws INDEXING_FAILED on failure/timeout

// Callback mode: the SDK drives the loop and returns the PoCWResult.
const result = await pocw.verify(knowledgeId, "learner-42", {
  difficulty_preset: "medium",
  onQuestion: async (q) => askUser(q.text, q.options),
});
console.log(result.score, result.concepts);

// Session mode: drive it yourself (this is what the HTTP API does).
const session = await pocw.verify(knowledgeId, "learner-42", { max_questions: 7 });
while (session.isActive()) {
  const feedback = await session.submitAnswer(await askUser(session.currentQuestion.text));
}
const final = await session.getResult();

await pocw.close();
```

| Method | Description |
|---|---|
| `init()` / `close()` | Open / close FalkorDB + SQLite |
| `index(source, { asText?, meta? })` | URL or raw text → `IndexResult` (background indexing, idempotent). `asText: true` never treats the input as a URL; `meta: { title?, author? }` supplies metadata found in an uploaded file |
| `getIndexStatus(knowledgeId)` | `IndexResult` (`{ knowledgeId, status, contentId?, error?, author? }`) |
| `waitForIndex(knowledgeId, timeoutMs = 300000)` | Resolves when `ready` |
| `listContent({ status?, limit?, offset?, includeHidden? })` | `{ rows: ContentRow[], total }` |
| `verify(knowledgeId, subject, config?)` | `VerifySession` (no `onQuestion`) or `PoCWResult` (with `onQuestion`) |
| `getContentChunks(knowledgeId)` | Cached text chunks (re-parsed after restart) |
| `setVisibility`, `deleteResource`, `reindexResource`, `wipeAll` | Admin operations |

---

## Types

### `PoCWConfig`

```ts
interface PoCWConfig {
  max_questions?: number;            // integer 1–50: the EXACT number of questions asked. Default 10 (or the preset's)
  difficulty_preset?: "easy" | "medium" | "hard"; // overrides difficulty/threshold; max_questions only if not given
  difficulty?: number;               // 0–1, default 0.5 — shifts every item's target difficulty (see below)
  q_types?: ("open" | "mcq" | "true_false")[];   // non-empty; default all three. Only these types are ever asked
  threshold?: number;                // 0–1, default 0.7 → competenceIndicator when score ≥ 70
  response?: "boolean" | "score" | "detailed";   // "detailed" adds response_detail
  model?: string;                    // OpenRouter model override (HTTP: ignored unless ALLOW_MODEL_OVERRIDE=true)
  language?: string;                 // question language (default: content language)
  persona?: string;                  // framing, e.g. "explain to a 12-year-old"
  // model / language / persona: strings of at most 200 characters. Wrong types → 400 INVALID_CONFIG.
  onQuestion?: (q: VerifyQuestion) => Promise<string>; // SDK callback mode only
}
```

| Preset | difficulty | threshold | max_questions (default) |
|---|---|---|---|
| `easy` | 0.20 | 0.35 | 10 |
| `medium` | 0.40 | 0.50 | 15 |
| `hard` | 0.65 | 0.65 | 20 |

- **`max_questions`** is the session length: the session asks exactly this many questions — it is
  not raised to the number of important concepts and does not stop early on IRT convergence. An
  explicit `max_questions` wins over a preset's. `maxQuestions` (response of `POST /api/verify`) and
  every `question.totalQuestions` equal it. If the content has more important concepts than
  questions, the most important ones are asked first.
- **`difficulty`** sets the centre of the item-difficulty band: offset `2.5 × (difficulty − 0.55)`
  on the IRT scale, target = offset + small importance nudge + ½ θ. Easy 0.2 → −0.875 (Remember/
  Understand, true/false + MCQ), medium 0.4 → −0.375 (Understand/Apply; a strong learner stays at or
  below Analyze in a 5-question test), hard 0.65 → +0.25 (Apply/Analyze); default 0.5 → −0.125.
  Question targets are capped at **Analyze** (no Evaluate/Create questions): difficulty changes the
  depth of a question, not its wording. The learner's ability θ moves the target up or
  down by at most ±1 around that centre. See [OPTIONS.md §2](OPTIONS.md#2-concept-mastery-loop).
- **`q_types`**: with several types, the type follows the item's target difficulty among the
  allowed types only (true/false for easier items, then MCQ, then open). If generating the
  preferred type fails, the next allowed type is tried — never a type outside `q_types`.

### `VerifyQuestion`

```ts
interface VerifyQuestion {
  text: string;
  number: number;           // 1-based
  type: "open" | "mcq" | "true_false";
  bloomLevel: string;       // Remember | Understand | Apply | Analyze
  difficulty: number;       // IRT b, [−2, 2]: LLM rating anchored to the item's target (±0.25)
  totalQuestions: number;   // exact number of questions in the session (= maxQuestions)
  options?: string[];       // mcq only (4 items)
}
```

### `AnswerFeedback`

```ts
interface AnswerFeedback {
  correct: boolean;
  score: number;                                   // 0–100
  reasoning: string;                               // open: derived from keyPoints
  dimensions?: { covered_points: number; total_points: number; precision_cap: number }; // open
  irtParams?: { a: number; b: number; c: number; d: number; importance: number; theta_before: number };
  referenceKeyPoints?: string[];                   // open
  keyPoints?: Array<{ point: string; status: "covered" | "partial" | "missing" }>; // open
  modelAnswer?: string;                            // open: 1–3 sentence answer
  gradedBy?: "jev" | "llm";                        // open: which grader decided
  correctAnswer?: string;                          // mcq / true_false
  progress: { questionNumber: number; theta: number; se: number; bloomLevel: string };
  isComplete: boolean;
}
```

### `PoCWResult`

```ts
interface PoCWResult {
  competenceIndicator: boolean;
  score: number;
  theta: number;
  se: number;
  converged: boolean;
  confidence_interval: [number, number];
  questions_asked: number;
  response_detail?: Array<{
    question: string; type: QuestionType; score: number; difficulty: number;
    bloomLevel: string; correct: boolean; conceptId: string | null;
  }>;
  concepts: Array<{ id: string; label: string; asked: number; correct: number; mastered: boolean }>;
  profile: {
    title: string; source: string; bloomLevelsReached: string[];
    bloomCoverage: Record<string, number>; aberrant: boolean; questionTypes: QuestionType[];
  };
  knowledgeId: string;
  contentId: number;
  subject: string;
  timestamp: string;
  disclaimers: { irtCalibration: string; bloomMapping: string; thresholdSemantics: string };
}
```

---

## Errors

| Code | HTTP | Meaning |
|---|---|---|
| `CONTENT_NOT_FOUND` | 404 | Unknown knowledge id |
| `INDEXING_IN_PROGRESS` | 202 | Content still indexing (`Retry-After: 5`) |
| `INDEXING_FAILED` | 422 | Indexing failed (see `error`) |
| `INVALID_CONFIG` | 400 | Invalid input or configuration (also 413/415 for upload limits) |
| `SESSION_EXPIRED` | 404 / 410 | Session unknown or expired |
| `SESSION_NOT_ACTIVE` | 409 | Session already complete / not complete yet |
| `SESSION_BUSY` | 409 | An answer for this session is already being processed |
| `LLM_ERROR` | 503 | LLM call failed (retry) |
| `GRAPH_DB_ERROR` | 503 | FalkorDB unavailable |
| `CAPACITY_EXCEEDED` | 429 | Rate limit |
| `UNAUTHORIZED` | 401 | Missing/invalid bearer key |
| `FORBIDDEN` | 403 | Admin API disabled |
| `NOT_FOUND` | 404 | Unknown `/api` route |
| `INTERNAL` | 500 | Unexpected error (details logged server-side) |

SDK methods throw `PoCWError` with the same `code`.
