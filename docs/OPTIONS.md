# PoCW — Internals Reference

How the engine works under the hood: indexing, IRT model, parameter sources, concept mastery loop, question selection, grading, stopping conditions and the result.

---

## 1. Indexing Pipeline

```
source (http(s) URL / uploaded PDF, EPUB, TXT, MD ≤ 40 MB)
  │
  ▼  Parser (jsdom main-content extraction, pdf-parse, EPUB, YouTube transcript)
  │    ↳ URL fetches go through safeFetch: SSRF-guarded (private/internal targets,
  │      incl. Docker service names and redirects to them, are refused), 50 MB / 120 s caps
  │    ↳ EPUB: container.xml → OPF → spine order → XHTML → text (lightweight tag stripper,
  │      no DOM per chapter); ZIP reader capped at 10 000 entries / 60 MB inflated
  │    ↳ HTML > 1 MB (book-sized pages) uses the same tag stripper instead of jsdom
  │    ↳ Project Gutenberg header/footer stripped; title/author from EPUB OPF, PDF info or the
  │      Gutenberg header (author: life dates / "active …" qualifiers stripped, "Surname,
  │      Forename" turned round when unambiguous); text cut to 4 000 000 characters
  │
  ▼  Chunker (4000 characters, 500-character overlap)
  │
  ▼  LLM (KG extraction prompt) — sampled chunks, 4 calls in parallel
  │    ↳ ≤ 15 chunks: all; else 2·√chunks (max 40), one from the middle of each equal slice
  │    ↳ nodes: { id, label, bloomLevel, importance (1–10) }
  │    ↳ edges: { source, target, relationship }
  │
  ▼  Merge across chunks
  │    same canonical label (case, accents, articles, possessives, plural "s",
  │    parentheticals ignored) → one node; score = Σ importance over chunks;
  │    top 50 nodes kept, ≤ 150 most frequent edges between them
  │
  ▼  Importance normalization (over the merged graph)
  │    score = 0.6 × importance_rank + 0.4 × degree_rank
  │    result: 0.00–1.00, guaranteed to span the full range
  │
  ▼  FalkorDB (graph store, keyed by numeric contentId)
```

A novel (≈ 300–1 000 chunks) costs 40 extraction calls; at 4 in parallel indexing takes about
1–2 minutes. Questions later draw their source passage from the whole book: the least-used chunk
that mentions the targeted concept (full label, else all its significant words, else its words
one by one), or any least-used chunk when none does.

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
b_target = clamp(offset + 0.3 × (importance − 0.5) + 0.5 × θ, −2, 2)   (Fisher mode: no importance term)
offset   = 2.5 × (difficulty − 0.55)                                    (config.difficulty ∈ [0, 1])
```

| `difficulty` | offset | first target at θ = 0 | strong learner (all correct) | struggling learner |
|---|---|---|---|---|
| 0.20 (easy) | −0.875 | −0.83 … −0.73: Understand, true/false | stays Understand (true/false, then MCQ) | Remember |
| 0.40 (medium) | −0.375 | −0.33 … −0.23: Understand, MCQ | Understand → Apply; never past Analyze within 5 questions | Understand → Remember |
| 0.50 (default) | −0.125 | −0.08 … +0.03: Understand/Apply, MCQ | Apply → Analyze | Understand → Remember |
| 0.65 (hard) | +0.25 | +0.30 … +0.40: Apply, MCQ | Apply → Analyze (open questions from question 3–4; Bloom targets are capped at Analyze, §5) | Apply → Understand |

(Simulated with the 4PL update and an LLM rating anchored to ±0.25 — both an LLM that rates every
item 1.0 and one that rates at the target; see `tests/irt-engine.test.ts`.)

Why θ enters at half weight: for an all-correct learner θ ≈ hardest item + up to 1.0, so with
`b_target = θ + …` every correct answer raised the next target by 0.35–1.0 on top of the last one
(medium reached Evaluate/Create by question 4–5, hard reached Create by question 2). With 0.5 × θ
the target converges: the difficulty setting fixes the centre of the band and θ moves the target
at most ±1 around it, up for strong learners and down for struggling ones. The importance term
(formerly × 1.5, always positive for important concepts) is now a small nudge. The maximum target
at θ = 2 is `offset + 1.15`. (Targets above b = 0.5 are Analyze-level questions: Bloom targets
stop at Analyze, see §5.)

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

All-correct / all-wrong patterns use a bounded heuristic θ = max(b) + min(0.5·ln(n+1), 1)
(resp. min(b) − …), clamped to [−2, 2] — but never less extreme than the MAP estimate in the
direction of the evidence (all-correct: max(heuristic, MAP); all-wrong: min(heuristic, MAP)).
Without that bound one wrong answer on a moderately hard item (b = 0.6 → θ = 0.25) raised θ above
the prior, and a correct answer on an easy item lowered it.

---

## 5. Bloom Levels

Bloom's Taxonomy is descriptive: it drives **which** question is generated (the IRT target
difficulty is mapped to a suggested Bloom level) and is reported in the result profile
(`bloomCoverage`, `bloomLevelsReached`). It does **not** weight the ability estimate.

```
target difficulty b → suggested Bloom (question target):
  < −1.0 → Remember     who / what / where — one fact
  <  0.0 → Understand   why something happens, what something means
  <  0.5 → Apply        what would X do / what would happen if … (a situation the book sets up)
  ≥  0.5 → Analyze      how two things are connected, what led to something
```

Targets are **capped at Analyze** (`bloomTargetFor` / `MAX_TARGET_BLOOM` in `irt-engine.ts`):
Evaluate/Create targets produced academic, convoluted questions, so anything above maps to
Analyze, and a Bloom level above Analyze returned by the LLM is stored as Analyze.
(`difficultyToBloom` still has the full six-level mapping; the KG keeps all six levels for concepts.)

The question-generation LLM assigns the final Bloom level of each question (it may differ from the suggestion).
`config.difficulty` shifts the target difficulty and therefore the suggested Bloom level (§2).

**Question style.** The generation prompts (`ai-config.yml`) ask for questions that read like a
friend who read the book asking about it: one sentence of at most ~20 words, everyday words, one
clear answer that is in the passage; no jargon ("analyze", "evaluate the significance", "to what
extent", "according to the passage"…), no multi-part questions, no invented scenarios. Difficulty
changes the depth (the patterns above), never the phrasing. MCQ: 4 short options of similar length,
exactly one correct per the text. True/false: one simple fact; the engine picks the target answer
(true/false) at random for each statement so about half are false.

**Question check (decisions model, `question-check-model`).** Before a question is shown, one Jev
call asks: for MCQ, which option is correct according to the passage (criteria = the 4 options);
for every type, `answerable_from_passage` (yes/no) and `plainly_worded` (yes/no). If Jev picks a
different MCQ option than the key with confidence ≥ 0.6, or answers "no" to either yes/no question
with confidence ≥ 0.7, the question is regenerated **once** with that feedback (the regenerated
question is used as is). A failed check, or a failed regeneration, keeps the original question.
Outcomes are stored on the call-log row and summarised in `GET /api/usage` (`quality.questionCheck`).

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

## 7. Open Question Grading (Jev + LLM escalation)

Open answers are graded **key point by key point**. Each open question is generated with a
`modelAnswer` (1–3 plain sentences) and 1–4 short, checkable `keyPoints` (2–4 normally; a
one-fact question gets 1–2 so a correct short answer is never penalised for "missing" padding).

**System One — Jev (`grade-decisions-model`, OpenRouter decisions API).** One call per answer:

```
state     = { question, key_points, source_passage, student_answer (fenced), security_note }
questions = kp_1 … kp_n : choice { covered | partial | missing }
            verdict     : choice { correct | partial | wrong }

coverage = Σ(covered = 1, partial = ½) / n
score    = round(100 × coverage), capped at 40 when verdict = wrong
correct  = score ≥ 70
```

**Escalation → LLM grader (`grade-model`, GPT-6 Luna, reasoning low)** when:
- any key-point or verdict confidence < 0.6 (`low_confidence`);
- verdict and coverage disagree: verdict correct but coverage < 0.5, or verdict wrong but
  coverage > 0.7 (`disagreement`);
- the Jev call fails, times out (10 s, one retry) or returns an unusable answer (`jev_error`);
- the question has no key points (`no_key_points`).

The LLM grader returns the same per-key-point statuses + verdict and is scored with the same
formula. If the escalation itself fails, Jev's grade is used — a Jev or escalation failure never
fails the learner's request on its own. Without `grade-decisions-model` (e.g. the baseline config)
the LLM grader grades every answer; its legacy `covered_points / total_points / precision_cap`
format is still understood.

The answer feedback carries `keyPoints` (statuses), `modelAnswer`, `gradedBy` (`jev` | `llm`) and a
`reasoning` sentence derived from the key points ("You covered 2 of 3 key points.").

**Prompt-injection guard.** The student answer is untrusted: it is fenced between
`---STUDENT_ANSWER_START---` / `---STUDENT_ANSWER_END---` (marker look-alikes inside it are
replaced), and every Jev instruction and the LLM grader prompt say to ignore instructions inside it.

**Anti-bias rules** (both graders): meaning over wording or length; a confident tone or extra words
never raise the grade; restating the question or "I don't know" is wrong.

MCQ and true/false answers are graded deterministically (exact match, no model call).

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
