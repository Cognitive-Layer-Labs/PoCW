# PoCW — Internals Reference

How the engine works under the hood: indexing, IRT model, parameter sources, concept mastery loop, question selection, grading, stopping conditions and the result.

---

## 1. Indexing Pipeline

```
source (http(s) URL / uploaded PDF / uploaded text)
  │
  ▼  Parser (jsdom main-content extraction, pdf-parse, YouTube transcript)
  │    ↳ URL fetches go through safeFetch: SSRF-guarded (private/internal targets,
  │      incl. Docker service names and redirects to them, are refused), 50 MB / 30 s caps
  │
  ▼  Chunker (4000 characters, 500-character overlap)
  │
  ▼  LLM (KG extraction prompt) — for up to 15 evenly sampled chunks
  │    ↳ nodes: { id, label, bloomLevel, importance (1–10) }
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

At session start, the engine loads all nodes with `importance ≥ 0.65` (preset: easy 0.80, hard 0.50) as **important concepts** (minimum 3, regardless of threshold). Each concept starts as `untested`.

The session length is fixed (`max_questions`, see §9). It is never raised to cover every important
concept: when there are more important concepts than questions, the most important are asked first
and the least important may stay untested (`asked: 0` in `concepts[]`).

```
untested → asked → mastered   (correct answer)
                 → failed     (wrong, askCount < 3)
                 → failed_final (wrong, askCount == 3)
```

**Question target selection priority:**
1. `failed` concepts first (re-ask with a different KG edge direction)
2. `untested` concepts next (in descending importance order)
3. If all important concepts are resolved: pure IRT Fisher information maximization (targets the b closest to current θ)

**Target difficulty of the next item:**

```
b_target = clamp(θ + (importance − 0.5) × 1.5 + offset, −2, 2)     (Fisher mode: θ + offset)
offset   = 3 × (difficulty − 0.6)                                  (config.difficulty ∈ [0, 1])
```

| `difficulty` | offset | first targets at θ = 0 (importance 0.65–1.0) | typical Bloom / type |
|---|---|---|---|
| 0.20 (easy) | −1.20 | −0.98 … −0.45 | Remember/Understand, true/false + MCQ |
| 0.40 (medium) | −0.60 | −0.38 … +0.15 | Understand/Apply, MCQ |
| 0.50 (default) | −0.30 | −0.08 … +0.45 | Understand/Apply |
| 0.65 (hard) | +0.15 | +0.38 … +0.90 | Apply/Analyze, rising to Evaluate |

The offset is constant for the session; θ still moves the target after every answer, so a strong
learner gets harder items and a struggling one easier items within the chosen band.

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
| `b` | Item difficulty | [−2, 2] | KAQG LLM's per-question difficulty rating, anchored to `b_target` ± 0.25 |
| `a` | Discrimination | [0.5, 2.5] | Target concept's contextual importance (KG) |
| `c` | Lower asymptote (guessing) | 0–0.5 | Type-based rule (see below) |
| `d` | Upper asymptote | constant | Fixed `1.0` |

**Type-based `c` (guessing probability):**

| Question type | c value | Reasoning |
|---|---|---|
| `true_false` | 0.50 | 50% random guess chance |
| `mcq` | 0.25 | 25% random guess chance (4 options) |
| `open` | 0.00 | No guessing possible on free text |

**Parameter sources:**

- `b` is the KAQG LLM's own difficulty rating for the generated question, clamped to
  `b_target ± 0.25` (and [−2, 2]); `b_target` itself when the rating is missing. The generator is
  told `TARGET_DIFFICULTY`, but uncalibrated ratings drift (a live run rated every question 1.0),
  and an unanchored over-rating makes every answer — even a wrong one — push θ up, which walks the
  session towards Evaluate/Create. The same anchored value is returned as `question.difficulty`.
- `a = clamp(0.5, 2.5, 0.5 + 2.0 × importance)`, where `importance` ∈ [0, 1] is the target
  concept's contextual importance in the Knowledge Graph (more central concept ⇒ more discriminating).
- `c` is the type-based guessing floor (table above).
- `d = 1.0` (constant upper asymptote, so P(correct) → 1 at high ability and the
  `(θ + 2) / 4 × 100` score projection stays self-consistent).

> **Note.** Earlier versions blended in a Python/XGBoost "IRT predictor" sidecar for `a`/`b`/`d`.
> That was removed: text-only semantic difficulty prediction proved too weak to add signal (see the
> `irt-difficulty-2-0` experiments), so the parameters now come from signals the pipeline already has.

---

## 4. IRT Ability Update (MAP Newton-Raphson)

After each answer, θ is re-estimated over **all** responses so far with standard
(unweighted) 4PL **Maximum A Posteriori** estimation:

```
Prior:  θ ~ N(0, 1)

For each response i (u_i ∈ {0, 1}):
  P_i   = 4PL probability at current θ
  P'_i  = a_i (P_i − c_i)(d_i − P_i) / (d_i − c_i)

  gradient  = Σ (u_i − P_i) P'_i / (P_i (1 − P_i))  − θ
  hessian   = − Σ P'_i² / (P_i (1 − P_i))           − 1

θ ← clamp(θ − gradient / hessian, −2, 2)     (step halved while |Δ| > 1.5, ≤ 50 iterations)
SE = 1 / sqrt(1 + Σ FisherInfo_i(θ))
```

All-correct / all-wrong patterns (where MAP is ill-conditioned) use a bounded heuristic:
θ = max(b) + min(0.5·ln(n+1), 1) (resp. min(b) − …), clamped to [−2, 2].

---

## 5. Bloom Levels

Bloom's Taxonomy is descriptive: it drives **which** question is generated (the IRT target
difficulty is mapped to a suggested Bloom level) and is reported in the result profile
(`bloomCoverage`, `bloomLevelsReached`). It does **not** weight the ability estimate.

```
target difficulty b → suggested Bloom:
  < −1.0 → Remember
  <  0.0 → Understand
  <  0.5 → Apply
  <  1.0 → Analyze
  <  1.5 → Evaluate
  ≥  1.5 → Create
```

The question-generation LLM assigns the final Bloom level of each question (it may differ from the suggestion).
`config.difficulty` shifts the target difficulty and therefore the suggested Bloom level (§2). The
generation prompts ask for plain, direct, single-fact questions at Remember/Understand.

---

## 6. Question Type Selection (Mixed Mode)

When `q_types` contains more than one type (default: all three), the type is selected by the IRT `b_target` for that question:

| b_target | Selected type | Reasoning |
|---|---|---|
| < −0.5 | `true_false` | Easy questions: binary recall check |
| −0.5 to 0.5 | `mcq` | Medium difficulty: structured application |
| ≥ 0.5 | `open` | Hard questions: free-text reasoning required |

Only types in `q_types` are ever used. Each type has a centre (true_false −1, mcq 0, open +1) and the
allowed type nearest `b_target` wins (ties → the harder type), so with a subset the bands merge:

| `q_types` | Selection |
|---|---|
| `mcq` + `true_false` | true_false below −0.5, mcq above |
| `open` + `true_false` | true_false below 0, open above |
| `open` + `mcq` | mcq below 0.5, open above |

If the chosen type cannot be generated, the next allowed type (by the same distance) is tried; if
none can, the request fails — the engine never substitutes a type outside `q_types`.
Set `q_types: ["mcq"]` (single type) to always use MCQ regardless of difficulty.

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

The default threshold is `threshold = 0.7`: `competenceIndicator` is true when score ≥ 70 (θ ≥ 0.8).
Difficulty presets override it (easy 0.35, medium 0.50, hard 0.65).

---

## 9. Stopping Conditions

Sessions are fixed-length: the session ends after exactly `maxQuestions` answers, where
`maxQuestions` (returned by `POST /api/verify`, and `totalQuestions` on every question) is
`max_questions` — the caller's value, else the preset's, else 10. It is not raised to the number of
important concepts and it is not cut short.

IRT convergence (`questionsAsked ≥ 4 AND SE < 0.40`, or `questionsAsked ≥ 15`) is reported as
`converged` in the result but does not end the session; neither does resolving every important
concept. The only way a session ends early is an error (e.g. no allowed question type can be
generated from the content), which is returned to the caller.

---

## 10. Result: Per-Concept Outcomes and Profile

Every result carries:

- `concepts[]` — one entry per **important concept** tracked by the mastery loop (label from the KG
  node), in descending importance: `{ id, label, asked, correct, mastered }`. `asked`/`correct` count
  the questions tied to that concept; `mastered` is true when the mastery loop marked it mastered.
  Concepts that were never reached have `asked: 0`.
- `response_detail[].conceptId` (when `response: "detailed"`) — the KG concept the question targeted.
  Questions generated in pure-Fisher mode are matched to a tracked concept by label; otherwise `null`.
- `profile` — `{ title, source, bloomLevelsReached, bloomCoverage, aberrant, questionTypes }`
  (`aberrant` is a simple person-fit flag: ≥ 4 answers, all correct, mean item difficulty ≥ θ + 0.5).
- `disclaimers` — interpretation caveats (uncalibrated IRT, heuristic Bloom mapping and threshold).

The result is computed once when first requested and then frozen for the lifetime of the session
(30 minutes in Redis), so repeated `GET /api/verify/:sessionId/result` calls return the same body.
