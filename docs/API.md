# PoCW — API Reference

## SDK Quick Start

```ts
import { PoCW } from "./oracle-service/src/sdk/index";

const pocw = new PoCW();
await pocw.init();

// 1. Index content
const { knowledgeId } = await pocw.index("https://en.wikipedia.org/wiki/Ethereum");
await pocw.waitForIndex(knowledgeId);

// 2. Verify knowledge (callback mode)
const result = await pocw.verify(knowledgeId, "0xUserAddress", {
  max_questions: 7,
  q_types: ["open", "mcq", "true_false"],
  attest: "onchain",
  chain: { controllerAddress: "0x...", sbtAddress: "0x..." },
  onQuestion: async (q) => {
    console.log(q.text);
    return readlineAnswer();
  },
});

console.log(result.score, result.competenceIndicator);
await pocw.close();
```

---

## `pocw.init(config?)`

Initialize the SDK. Must be called before any other method.

```ts
interface PoCWInitConfig {
  dataDir?: string;    // SQLite data directory (default: oracle-service/data)
}
```

---

## `pocw.index(source)`

Index content for later verification. Returns immediately; indexing runs in the background.

**Parameters:**

| Name | Type | Description |
|---|---|---|
| `source` | `string` | URL, IPFS CID (`ipfs://...`), or raw text |

**Returns:** `Promise<IndexResult>`

```ts
interface IndexResult {
  knowledgeId: string;  // deterministic sha256 of normalized source
  status: "pending" | "indexing" | "ready" | "failed";
  contentId?: number;   // numeric ID for FalkorDB graph
  error?: string;       // only if status = "failed"
}
```

**Supported content types:**
- URLs: HTML pages, PDFs, plain text files
- IPFS: `ipfs://Qm...` CIDs
- YouTube: transcript extraction from video URLs
- Raw text: any string that isn't a URL or CID

**Behavior:**
- Idempotent — calling with the same source returns the existing entry
- The KG build step calls an LLM to extract concepts and relationships
- Status is tracked in SQLite (`data/pocw.db`)

---

## `pocw.waitForIndex(knowledgeId, timeoutMs?)`

Poll until indexing completes. Resolves when status becomes `"ready"`.

| Param | Type | Default |
|---|---|---|
| `knowledgeId` | `string` | — |
| `timeoutMs` | `number` | `300000` |

**Throws:** `INDEXING_FAILED` if indexing fails or times out.

---

## `pocw.verify(knowledgeId, subject, config?)`

Start a verification session. Two modes:

### Callback mode

Provide `config.onQuestion`. The SDK drives the Q&A loop and returns the final `PoCWResult`.

```ts
const result = await pocw.verify(knowledgeId, userAddress, {
  max_questions: 7,
  onQuestion: async (q) => {
    // present question, return user's answer string
    return answer;
  },
});
```

### Session mode

Without `onQuestion`, returns a `VerifySession` for step-by-step control (used by the HTTP server).

```ts
const session = await pocw.verify(knowledgeId, userAddress, { max_questions: 7 });

while (session.isActive()) {
  const q = session.currentQuestion;   // VerifyQuestion
  const feedback = await session.submitAnswer(userAnswer);
  console.log(feedback.correct, feedback.score);
}

const result = await session.getResult();
```

---

## Verify Config Reference

```ts
interface PoCWConfig {
  max_questions?: number;
  difficulty?: number;
  threshold?: number;
  q_types?: QuestionType[];
  response?: "boolean" | "score" | "detailed";
  attest?: "onchain" | "offchain" | "none";
  chain?: ChainConfig;
  language?: string;
  persona?: string;
  model?: string;
  onQuestion?: (q: VerifyQuestion) => Promise<string>;
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `max_questions` | `number` | `10` | Maximum questions before session ends (1–50) |
| `difficulty` | `number` | `0.5` | Starting difficulty 0–1. Maps to IRT θ₀: `(val × 4) − 2`. 0 = easiest (θ=−2), 1 = hardest (θ=2). |
| `threshold` | `number` | `0.7` | Pass/fail cutoff 0–1. Score ≥ `threshold × 100` passes. |
| `q_types` | `QuestionType[]` | `["open","mcq","true_false"]` | Question types. Use a single type to lock it; all three = difficulty-driven mixed mode. |
| `response` | `string` | `"score"` | `"boolean"`: pass/fail only. `"score"`: + numeric score. `"detailed"`: + per-question breakdown. |
| `attest` | `string` | `"none"` | `"none"` / `"offchain"` / `"onchain"`. Onchain includes oracle signature for `verifyAndMint`. |
| `chain` | `ChainConfig` | — | Required when `attest = "onchain"`. |
| `language` | `string` | auto | Language for generated questions. Omit to match content language. |
| `persona` | `string` | — | Question framing, e.g. `"university professor"`, `"explain to a 5-year-old"`. |
| `model` | `string` | from ai-config.yml | OpenRouter model ID override for all LLM calls in this session. |
| `onQuestion` | `function` | — | Callback mode hook. Receives `VerifyQuestion`, must return the user's answer string. |

```ts
interface ChainConfig {
  controllerAddress: string;  // deployed PoCW_Controller address
  sbtAddress: string;         // deployed PoCW_SBT address
}
```

---

## VerifyQuestion

```ts
interface VerifyQuestion {
  text: string;           // question text (or T/F statement)
  number: number;         // 1-indexed position in session
  type: QuestionType;     // "open" | "mcq" | "true_false"
  bloomLevel: string;     // Bloom's level: Remember → Create
  difficulty: number;     // IRT b parameter used to generate this question
  totalQuestions: number; // max_questions for this session
  options?: string[];     // MCQ only: exactly 4 options, no letter prefix
}
```

**Question types:**

| Type | Answer format | Graded by |
|---|---|---|
| `"open"` | Free text | LLM (claim-based) |
| `"mcq"` | `"A"`, `"B"`, `"C"`, or `"D"` | Exact match (no LLM call) |
| `"true_false"` | `"true"` or `"false"` (also: `"t"`, `"f"`, `"yes"`, `"no"`) | Exact match (no LLM call) |

---

## AnswerFeedback

Returned by `session.submitAnswer()`.

```ts
interface AnswerFeedback {
  correct: boolean;
  score: number;           // 0–100
  reasoning: string;       // explanation of correctness
  dimensions?: {           // open questions only
    covered_points: number;  // key points correctly covered
    total_points: number;    // total key points
    precision_cap: number;   // 100 | 60 | 40 (conceptual precision gate)
  };
  progress: {
    questionNumber: number;
    theta: number;          // current IRT ability estimate θ ∈ [−2, 2]
    se: number;             // standard error of estimate
    bloomLevel: string;
  };
  isComplete: boolean;
}
```

---

## PoCWResult

Final result returned after session completes.

```ts
interface PoCWResult {
  competenceIndicator: boolean;          // score >= threshold * 100
  score: number;                         // 0–100, mapped from θ
  theta: number;                         // IRT ability estimate ∈ [−2, 2]
  se: number;                            // standard error
  converged: boolean;                    // SE < 0.40
  confidence_interval: [number, number]; // [low, high] scores from θ ± 1.96·SE
  questions_asked: number;
  response_detail?: ScoreBreakdown[];    // only if response = "detailed"
  attestation?: AttestationResult;       // only if attest != "none"
  knowledgeId: string;
  contentId: number;
  subject: string;
  timestamp: string;                     // ISO 8601
  tokenUri?: string;                     // base64 ERC-1155 metadata URI
}

interface ScoreBreakdown {
  question: string;
  type: QuestionType;
  score: number;
  difficulty: number;
  bloomLevel: string;
  correct: boolean;
}
```

---

## Attestation

### Off-chain (`attest: "offchain"`)

```ts
interface OffchainAttestation {
  type: "offchain";
  signature: string;   // oracle's EIP-191 signature
  contentId: number;
  score: number;
  nonce: string;       // bytes32 replay protection
  expiry: number;      // unix timestamp
  tokenUri: string;    // base64 ERC-1155 metadata
  oracle: string;      // oracle Ethereum address
}
```

### On-chain (`attest: "onchain"`)

Same as offchain plus contract addresses. Use the returned fields to call `verifyAndMint`:

```ts
interface OnchainAttestation extends OffchainAttestation {
  type: "onchain";
  controllerAddress: string;
  sbtAddress: string;
}
```

**Minting the SBT:**

```ts
const att = result.attestation as OnchainAttestation;

await controller.verifyAndMint(
  userAddress,
  att.contentId,
  result.score,
  att.expiry,
  att.nonce,
  result.tokenUri ?? "",
  att.signature
);
```

The `PoCW_Controller` verifies the oracle signature on-chain, marks the nonce as used, sets the token URI, and mints the SBT. The SDK never sends the transaction — that is always the caller's responsibility.

---

## REST API

The Oracle service exposes an Express HTTP API. Authenticate with `Authorization: Bearer <POCW_API_KEY>`.

### `POST /api/index`

Start indexing content.

**Request:**
```json
{ "source": "https://example.com/article" }
```

**Response 202:**
```json
{ "knowledgeId": "abc...", "status": "indexing", "contentId": 42 }
```

---

### `POST /api/upload`

Upload a file (PDF or text) and index it.

**Request:** `multipart/form-data` with a `file` field.

**Response 202:** Same as `/api/index`.

---

### `GET /api/index/:knowledgeId`

Check indexing status.

**Response 200:**
```json
{ "knowledgeId": "abc...", "status": "ready", "contentId": 42 }
```

---

### `GET /api/index`

List all indexed content.

**Query params:** `?status=ready&limit=20&offset=0`

**Response 200:**
```json
{ "rows": [...], "total": 5 }
```

---

### `POST /api/verify`

Start a verification session.

**Request:**
```json
{
  "knowledgeId": "abc...",
  "subject": "0xUserAddress",
  "config": {
    "max_questions": 7,
    "q_types": ["open", "mcq", "true_false"],
    "attest": "onchain",
    "chain": { "controllerAddress": "0x...", "sbtAddress": "0x..." }
  }
}
```

**Response 200:**
```json
{
  "sessionId": "uuid",
  "question": {
    "text": "...",
    "number": 1,
    "type": "mcq",
    "bloomLevel": "Apply",
    "difficulty": 0.42,
    "totalQuestions": 7,
    "options": ["Option A", "Option B", "Option C", "Option D"]
  }
}
```

---

### `POST /api/verify/:sessionId/answer`

Submit an answer.

**Request:** `{ "answer": "B" }`

**Response 200:**
```json
{
  "correct": true,
  "score": 100,
  "reasoning": "Correct. Option B describes...",
  "progress": { "questionNumber": 1, "theta": 0.3, "se": 0.95, "bloomLevel": "Apply" },
  "isComplete": false,
  "nextQuestion": { ... }
}
```

When `isComplete` is `true`, `nextQuestion` is absent. Call `/result` to retrieve the final result.

---

### `GET /api/verify/:sessionId/result`

Get the final result. Only available after `isComplete = true`.

**Response 200:** Full `PoCWResult` object.

---

### `GET /health`

Liveness check.

**Response 200:** `{ "status": "ok", "uptime": 42.3 }`

---

## Error Reference

All SDK errors are `PoCWError` with a typed `code`. HTTP endpoints map them to status codes.

| Code | HTTP | Description |
|---|---|---|
| `CONTENT_NOT_FOUND` | 404 | Knowledge ID doesn't exist |
| `INDEXING_IN_PROGRESS` | 202 | Content still being indexed |
| `INDEXING_FAILED` | 422 | Indexing failed (check `error` field) |
| `INVALID_CONFIG` | 400 | Bad configuration parameter |
| `SESSION_EXPIRED` | 410 | Session timed out |
| `SESSION_NOT_ACTIVE` | 409 | No current question or session already complete |
| `LLM_ERROR` | 503 | LLM API call failed (circuit breaker open) |
| `GRAPH_DB_ERROR` | 503 | FalkorDB operation failed |
| `ATTESTATION_ERROR` | 500 | Oracle signing failed |
| `CAPACITY_EXCEEDED` | 429 | Rate limit exceeded |

```ts
try {
  await pocw.verify("nonexistent-id", "0xUser");
} catch (err) {
  if (err instanceof PoCWError) {
    console.log(err.code);    // "CONTENT_NOT_FOUND"
    console.log(err.message);
  }
}
```
