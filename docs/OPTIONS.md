# PoCW — Internals Reference

How the system works under the hood: IRT model, parameter sources, Bloom weights, concept mastery loop, question selection, grading, and stopping conditions.

---

## 1. Indexing Pipeline

```
source (URL / PDF / text)
  │
  ▼  Parser (html-to-text, pdf-parse, youtube transcript)
  │
  ▼  Chunker (~1000 tokens, 200-token overlap)
  │
  ▼  LLM (KG extraction prompt) — for each chunk
  │    ↳ nodes: { id, label, bloomLevel, importance (1–10), description }
  │    ↳ edges: { source, target, relationship }
  │
  ▼  Importance normalization
  │    score = 0.6 × importance_rank + 0.4 × degree_rank
  │    result: 0.00–1.00, guaranteed to span the full range
  │
  ▼  FalkorDB (graph store, keyed by numeric contentId)
```

**Why rank-based normalization?**
LLMs tend to cluster importance scores at 8–10 for most nodes. Rank-based scoring re-spreads them across 0–1, so the threshold `importance ≥ 0.65` always identifies a meaningful top tier regardless of how the LLM rated the content.

---

## 2. Concept Mastery Loop

At session start, the oracle loads all nodes with `importance ≥ 0.65` as **important concepts** (minimum 3, regardless of threshold). Each concept starts as `untested`.

```
untested → asked → mastered   (correct answer)
                 → failed     (wrong, askCount < 3)
                 → failed_final (wrong, askCount == 3)
```

**Question target selection priority:**
1. `failed` concepts first (re-ask with a different KG edge direction)
2. `untested` concepts next (in descending importance order)
3. If all important concepts are resolved: pure IRT Fisher information maximization (targets the b closest to current θ)

**Edge direction rotation on re-ask:**
Each concept has a graph with incoming and outgoing edges. Re-asks use a different slice of that graph to generate a different question:

| Ask # | Edge direction | Focus |
|---|---|---|
| 1 (first ask) | `direct` (both) | Concept in full context |
| 2 (retry) | `incoming` | What leads TO this concept (preconditions, causes) |
| 3 (final retry) | `outgoing` | What this concept ENABLES or CAUSES |

---

## 3. 4PL IRT Model

**The model:**

```
P(correct | θ) = c + (d − c) / (1 + exp(−a · (θ − b)))
```

| Parameter | Meaning | Range | Source |
|---|---|---|---|
| `θ` (theta) | User ability | [−2, 2] | Estimated via MAP Newton-Raphson |
| `b` | Item difficulty | [−2, 2] | Combined: 85% KAQG LLM + 15% IRT predictor |
| `a` | Discrimination | [0.5, 2.5] | IRT predictor (XGBoost), default 1.0 |
| `c` | Lower asymptote (guessing) | 0–0.5 | Type-based rule (see below) |
| `d` | Upper asymptote | [0.75, 1.0] | IRT predictor (XGBoost), default 0.95 |

**Type-based `c` (guessing probability):**

| Question type | c value | Reasoning |
|---|---|---|
| `true_false` | 0.50 | 50% random guess chance |
| `mcq` | 0.25 | 25% random guess chance (4 options) |
| `open` | 0.00 | No guessing possible on free text |

**Combined `b` formula:**

```
b_combined = 0.85 × b_llm + 0.15 × b_predictor
```

`b_llm` comes from the KAQG LLM (asked to estimate IRT difficulty in [−2, 2]).
`b_predictor` is XGBoost output from text features + embeddings.
The LLM weight is high (0.85) because the predictor's b prediction is weak (R²=0.086 on MMLU benchmark).
The predictor's `a` and `d` are used directly since they carry more signal relative to their scale.

If the predictor sidecar is unreachable: `a=1.0`, `d=0.95` (defaults), `b=b_llm`.

---

## 4. IRT Ability Update (MAP Newton-Raphson)

After each answer, θ is updated using **Maximum A Posteriori** estimation with a Bloom-weighted likelihood:

```
Prior:      θ ~ N(0, 1)
Likelihood: weighted by bloomWeight for this question

Update step (Newton-Raphson):
  P   = 4PL probability at current θ
  Q   = 1 − P
  W   = P × Q                             (Fisher information weight)
  W_b = W × bloomWeight                   (Bloom-weighted)

  ΔL = W_b × (response − P) / (P × Q)   (weighted score residual)
  ΔΔ = W_b × W / (P × Q)                (weighted curvature)

  dL  = ΔL × a − θ    (with prior gradient)
  d2L = ΔΔ × a² + 1   (with prior curvature)

  θ_new = clamp(θ − dL / d2L, −2, 2)
  SE    = 1 / sqrt(d2L)
```

θ is clamped to [−2, 2] after every update.

---

## 5. Bloom Level Weights

Bloom's Taxonomy is used as a **quality weight**, not a coverage axis. The protocol does not require testing all six levels — it asks what quality of reasoning the question demands.

| Bloom Level | Weight | Effect on θ update |
|---|---|---|
| Remember | 0.10 | Near-zero contribution (recall ≠ understanding) |
| Understand | 0.25 | Small contribution |
| Apply | 0.50 | Moderate contribution |
| Analyze | 0.80 | Strong contribution |
| Evaluate | 1.30 | Very strong contribution |
| Create | 2.00 | Maximum contribution |

A correct answer on a `Create`-level question moves θ ~20× more than a correct answer on a `Remember`-level question. This prevents "gaming" the test with easy recall questions.

**Bloom level assignment:**
The KAQG LLM assigns a Bloom level to each generated question. The IRT engine maps the IRT θ target to a suggested Bloom level, but the LLM's actual assignment is used for weighting (they may differ by ±1 level).

```
θ target → suggested Bloom:
  < −1.5 → Remember
  < −0.5 → Understand
  <  0.5 → Apply
  <  1.5 → Analyze
  ≥  1.5 → Evaluate / Create
```

---

## 6. Question Type Selection (Mixed Mode)

When `q_types` contains more than one type (default: all three), the type is selected by the IRT `b_target` for that question:

| b_target | Selected type | Reasoning |
|---|---|---|
| < −0.5 | `true_false` | Easy questions: binary recall check |
| −0.5 to 0.5 | `mcq` | Medium difficulty: structured application |
| ≥ 0.5 | `open` | Hard questions: free-text reasoning required |

Set `q_types: ["mcq"]` (single type) to override this and always use MCQ regardless of difficulty.

---

## 7. Open Question Grading (Claim Verification)

Open answers are graded by an LLM using **claim coverage**, not holistic scoring:

```
STEP 1 — CLAIM COVERAGE
  For each reference key point:
    covered_points += 1 if the student's answer correctly addresses it
  base_score = round(covered_points / total_points × 100)

STEP 2 — CONCEPTUAL PRECISION GATE
  Does the student correctly invoke the TARGET_CONCEPT?
    Never / incorrectly → precision_cap = 40
    Mentioned with errors → precision_cap = 60
    Correctly used → precision_cap = 100

  final_score = min(base_score, precision_cap)

STEP 3 — VERDICT
  correct = final_score ≥ 70
```

`referenceKeyPoints` are generated by the KAQG LLM at question-generation time (3–6 specific facts the answer must cover).

**Anti-bias rules baked into the grader prompt:**
- A longer answer is NOT automatically better.
- A confident tone does NOT raise the score.
- Restating the question without substance: covered_points = 0.
- The student answer arrives between security markers and is treated as untrusted input (prompt injection guard).

---

## 8. Score → θ Mapping

Final score is mapped from θ linearly:

```
score = round(((θ + 2) / 4) × 100)
```

This maps θ = −2 → score 0, θ = 0 → score 50, θ = +2 → score 100.

The default pass threshold is `threshold = 0.7`, meaning score ≥ 70 (θ ≥ 0.8) passes.

---

## 9. Stopping Conditions

The session ends when **any one** of these is true:

| Condition | Check |
|---|---|
| Max questions reached | `questionsAsked ≥ max_questions` |
| IRT converged | `SE < 0.40` |
| Concept mastery complete | All important concepts are `mastered` or `failed_final` AND `SE < 0.40` |

---

## 10. Attestation Payload

The oracle signs the following payload with EIP-191 (`eth_sign`):

```
keccak256(abi.encode(
  userAddress,
  contentId,
  score,
  nonce,       // bytes32, unique per session, stored on-chain to prevent replay
  expiry,      // unix timestamp, signature expires after this
  keccak256(bytes(tokenUri))  // base64-encoded ERC-1155 metadata
))
```

The SBT (`PoCW_SBT`) stores the `tokenUri` on-chain. It contains a base64-encoded JSON cognitive profile (θ, SE, score, question types, Bloom coverage, oracle address, timestamp). No external storage is used.

---

## 11. IRT Predictor Sidecar

The predictor is a FastAPI/XGBoost service that estimates IRT parameters from question text alone, without seeing user responses. It is trained on 11,270 questions from MMLU + BoolQ + TriviaQA benchmarked against 12 open-source language models.

**Input:** question text + answer choices (optional) + theta (optional)

**Output:** `{ a, b, c, d, p_correct, difficulty, discrimination }`

**Graceful fallback:** If the sidecar is unreachable, the oracle continues with `a=1.0, d=0.95` and uses `b_llm` directly. The `b_pred=n/a` is logged.

See `predictor/` for the service code and `PoCW-IRT-Calibrator/` for training code and model releases.
