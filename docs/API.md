# PoCW Protocol — API Reference

## Quick Start

```ts
import { PoCW } from "./oracle-service/src/sdk/index";

const pocw = new PoCW();
await pocw.init();

// 1. Index content
const { knowledgeId } = await pocw.index("https://example.com/article");
await pocw.waitForIndex(knowledgeId);

// 2. Verify knowledge (callback mode)
const result = await pocw.verify(knowledgeId, "0xUserAddress", {
  max_questions: 5,
  onQuestion: async (q) => prompt(q.text),
});

console.log(result.score, result.passed);
await pocw.close();
```

---

## `pocw.index(source)`

Index content for later verification. Returns immediately; indexing runs in the background.

**Parameters:**
| Name | Type | Description |
|------|------|-------------|
| `source` | `string` | URL, IPFS CID (`ipfs://...`), or raw text |

**Returns:** `Promise<IndexResult>`

```ts
interface IndexResult {
  knowledgeId: string;     // deterministic sha256 of normalized source
  status: "pending" | "indexing" | "ready" | "failed";
  contentId?: number;      // numeric ID for FalkorDB graph
  error?: string;          // only if status = "failed"
}
```

**Behavior:**
- Idempotent: calling with the same source returns the existing entry
- Content is parsed, chunked, and a knowledge graph is built in FalkorDB
- Status is tracked in SQLite (`data/pocw.db`)

**Supported content types:**
- URLs: HTML pages, PDFs, plain text files
- IPFS: `ipfs://Qm...` CIDs (fetched via gateway)
- YouTube: transcript extraction from video URLs
- Raw text: any string that isn't a URL or CID

---

## `pocw.waitForIndex(knowledgeId, timeoutMs?)`

Wait for indexing to complete. Resolves when status becomes `"ready"`.

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `knowledgeId` | `string` | — | From `index()` result |
| `timeoutMs` | `number` | `300000` | Timeout in milliseconds |

**Throws:** `INDEXING_FAILED` if indexing fails or times out.

---

## `pocw.getIndexStatus(knowledgeId)`

Check the current indexing status without waiting.

**Returns:** `IndexResult`

**Throws:** `CONTENT_NOT_FOUND` if the knowledge ID doesn't exist.

---

## `pocw.verify(knowledgeId, subject, config?)`

Start a verification session. Two modes:

### Callback Mode (returns result directly)

When `config.onQuestion` is provided, the SDK drives the Q&A loop internally and returns the final result.

```ts
const result = await pocw.verify(knowledgeId, subject, {
  max_questions: 5,
  onQuestion: async (q) => {
    // Display question to user, return their answer
    return userAnswer;
  },
});
// result: PoCWResult
```

### Session Mode (caller drives the loop)

Without `onQuestion`, returns a `VerifySession` for the caller to drive step-by-step.

```ts
const session = await pocw.verify(knowledgeId, subject, { max_questions: 5 });

while (session.isActive()) {
  const q = session.currentQuestion;
  // Present q to user...
  const feedback = await session.submitAnswer(userAnswer);
}

const result = await session.getResult();
```

---

## Config Reference

```ts
interface PoCWConfig {
  max_questions?: number;
  difficulty?: number;
  q_types?: QuestionType[];
  threshold?: number;
  response?: "boolean" | "score" | "detailed";
  model?: string;
  attest?: "onchain" | "offchain" | "none";
  chain?: ChainConfig;
  language?: string;
  persona?: string;
  onQuestion?: (q: VerifyQuestion) => Promise<string>;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `max_questions` | `number` | `10` | Maximum questions before session ends (1-50). IRT typically converges at 8-13 items. |
| `difficulty` | `number` | `0.5` | Starting difficulty 0-1. Maps to IRT b parameter: `(val * 6) - 3`. 0=easiest, 1=hardest. |
| `q_types` | `QuestionType[]` | `["open"]` | Question types to use. Available: `"open"`, `"mcq"`, `"true_false"`, `"scenario"`. |
| `threshold` | `number` | `0.7` | Pass/fail cutoff 0-1. A score of `threshold * 100` or above passes. |
| `response` | `string` | `"score"` | Detail level: `"boolean"` (pass/fail only), `"score"` (+ numeric score), `"detailed"` (+ per-question breakdown). |
| `model` | `string` | from ai-config.yml | OpenRouter model ID override for all LLM calls in this session. |
| `attest` | `string` | `"none"` | Attestation mode: `"none"`, `"offchain"` (oracle signature), `"onchain"` (signature + contract info). |
| `chain` | `ChainConfig` | — | Required when `attest = "onchain"`. Contains `controllerAddress` and `sbtAddress`. |
| `language` | `string` | auto-detect | Language for generated questions. If omitted, matches the content language. |
| `persona` | `string` | — | Framing style for questions, e.g. `"explain to a 5-year-old"`, `"university professor"`. |
| `onQuestion` | `function` | — | Callback mode: receives each question, returns the user's answer. |

---

## VerifySession

Returned by `verify()` when no `onQuestion` callback is provided.

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `sessionId` | `string` | UUID for this session |
| `currentQuestion` | `VerifyQuestion` | The current question to present |

### Methods

**`isActive(): boolean`** — Returns `true` if more questions remain.

**`submitAnswer(answer: string): Promise<AnswerFeedback>`** — Submit an answer and get feedback.

**`getResult(): Promise<PoCWResult>`** — Get the final result. Only callable after session completes.

---

## Question Types

### Open (`"open"`)

Free-text question requiring a written answer. Graded by LLM on 4 dimensions: accuracy, depth, specificity, reasoning (25 pts each, 100 total).

### Multiple Choice (`"mcq"`)

4-option question with exactly one correct answer. Options are labeled A-D. Graded instantly by exact match (no LLM call). Answer with the letter: `"A"`, `"B"`, `"C"`, or `"D"`.

```ts
// VerifyQuestion for MCQ
{
  text: "What is the capital of France?",
  type: "mcq",
  options: ["London", "Paris", "Berlin", "Madrid"],
  // ... other fields
}
```

### True/False (`"true_false"`)

A statement that is either true or false. Graded instantly by exact match. Answer with `"true"` or `"false"` (also accepts `"t"`, `"f"`, `"yes"`, `"no"`).

```ts
// VerifyQuestion for true_false
{
  text: "Water boils at 100 degrees Celsius at sea level.",
  type: "true_false",
  // options is undefined
}
```

### Scenario (`"scenario"`)

A realistic scenario followed by an open-ended question. Graded by LLM (same as open-ended).

---

## VerifyQuestion

```ts
interface VerifyQuestion {
  text: string;           // The question or statement
  number: number;         // Current question number (1-indexed)
  type: QuestionType;     // "open" | "mcq" | "true_false" | "scenario"
  bloomLevel: string;     // Bloom's Taxonomy level
  difficulty: number;     // IRT difficulty parameter
  totalQuestions: number;  // Max questions in this session
  options?: string[];     // MCQ: 4 options. Undefined for other types.
}
```

---

## AnswerFeedback

Returned by `session.submitAnswer()`.

```ts
interface AnswerFeedback {
  correct: boolean;
  score: number;          // 0-100
  reasoning: string;      // Why the answer was correct/incorrect
  dimensions?: {          // Only for open/scenario (LLM-graded)
    accuracy: number;     // 0-25
    depth: number;        // 0-25
    specificity: number;  // 0-25
    reasoning: number;    // 0-25
  };
  progress: {
    questionNumber: number;
    theta: number;        // Current IRT ability estimate
    se: number;           // Standard error
    bloomLevel: string;   // Current Bloom's level
  };
  isComplete: boolean;    // true if session is done
}
```

---

## PoCWResult

Final result returned after session completion.

```ts
interface PoCWResult {
  passed: boolean;                      // score >= threshold * 100
  score: number;                        // 0-100
  theta: number;                        // IRT ability estimate
  se: number;                           // Standard error
  converged: boolean;                   // IRT convergence reached
  confidence_interval: [number, number]; // Score CI from theta +/- 1.96*SE
  questions_asked: number;
  response_detail?: ScoreBreakdown[];   // Per-question breakdown (if response="detailed")
  attestation?: AttestationResult;      // Signature data (if attest != "none")
  knowledgeId: string;
  contentId: number;
  subject: string;
  timestamp: string;                    // ISO 8601
}
```

---

## Attestation

### Off-chain (`attest: "offchain"`)

Returns an oracle-signed attestation. The signature covers `(subject, contentId, score)`.

```ts
interface OffchainAttestation {
  type: "offchain";
  signature: string;      // Oracle's EIP-191 signature
  contentId: number;
  score: number;
  oracle: string;         // Oracle's Ethereum address
}
```

### On-chain (`attest: "onchain"`)

Same as off-chain, plus contract addresses for the caller to submit a mint transaction.

```ts
interface OnchainAttestation {
  type: "onchain";
  signature: string;
  contentId: number;
  score: number;
  oracle: string;
  controllerAddress: string;
  sbtAddress: string;
}
```

The SDK never sends transactions. The caller uses the returned signature to call `controller.verifyAndMint()`.

---

## Error Reference

All SDK errors are instances of `PoCWError` with a typed `code` field.

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `CONTENT_NOT_FOUND` | 404 | Knowledge ID doesn't exist |
| `INDEXING_IN_PROGRESS` | 202 | Content is still being indexed |
| `INDEXING_FAILED` | 422 | Indexing failed (check `error` field) |
| `INVALID_CONFIG` | 400 | Invalid configuration parameter |
| `SESSION_EXPIRED` | 410 | Session timed out |
| `SESSION_NOT_ACTIVE` | 409 | No current question / session complete |
| `LLM_ERROR` | 503 | LLM API call failed |
| `GRAPH_DB_ERROR` | 503 | FalkorDB operation failed |
| `ATTESTATION_ERROR` | 500 | Signing failed |
| `CAPACITY_EXCEEDED` | 429 | Rate limit / capacity exceeded |

```ts
try {
  await pocw.verify("nonexistent", "user");
} catch (err) {
  if (err instanceof PoCWError) {
    console.log(err.code);    // "CONTENT_NOT_FOUND"
    console.log(err.message); // "No content for knowledge ID: nonexistent"
  }
}
```

---

## REST API

The Express server (`oracle-service/src/server.ts`) exposes these endpoints:

### `POST /api/index`

Index content.

**Request:** `{ "source": "https://example.com/article" }`

**Response (202):** `{ "knowledgeId": "abc...", "status": "indexing", "contentId": 42 }`

### `GET /api/index/:knowledgeId`

Check indexing status.

**Response (200):** `{ "knowledgeId": "abc...", "status": "ready", "contentId": 42 }`

### `POST /api/verify`

Start a verification session.

**Request:** `{ "knowledgeId": "abc...", "subject": "0xUser", "config": { "max_questions": 5 } }`

**Response:** `{ "sessionId": "uuid", "question": { ... } }`

### `POST /api/verify/:sessionId/answer`

Submit an answer.

**Request:** `{ "answer": "The answer is B" }`

**Response:** `{ "correct": true, "score": 100, "reasoning": "...", "progress": { ... }, "isComplete": false }`

### `GET /api/verify/:sessionId/result`

Get final result (only after session is complete).

**Response:** Full `PoCWResult` object.

---

## On-Chain Attestation Flow

```ts
// 1. Verify with on-chain attestation
const result = await pocw.verify(knowledgeId, userAddress, {
  attest: "onchain",
  chain: {
    controllerAddress: "0xController...",
    sbtAddress: "0xSBT...",
  },
  onQuestion: async (q) => getUserAnswer(q),
});

// 2. Use the signature to mint SBT
if (result.attestation?.type === "onchain") {
  const { signature, contentId } = result.attestation;
  await controller.verifyAndMint(userAddress, contentId, result.score, signature);
}
```

The `PoCW_Controller` contract verifies the oracle's signature on-chain before minting the Soulbound Token.
