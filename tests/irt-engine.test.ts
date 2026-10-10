import { expect } from "chai";
import {
  createIRTState,
  updateAbility as updateAbility4PL,
  IRTState,
  selectNextDifficulty,
  isConverged,
  probability,
  difficultyToBloom,
  bloomToDifficulty,
  thetaToScore,
  IRT_CORRECT_THRESHOLD,
  selectNextQuestion,
  difficultyOffset,
  anchorItemDifficulty,
  ITEM_DIFFICULTY_MAX_DEVIATION,
} from "../src/services/irt-engine";

/** 4PL update with a=1, c=0, d=1 — reduces to the Rasch model these expectations are written for. */
function updateAbility(state: IRTState, b: number, correct: boolean, score: number, bloom: string): IRTState {
  return updateAbility4PL(state, b, 1, 0, 1, correct, score, bloom);
}

describe("IRT Engine (4PL, Rasch-equivalent params)", () => {
  describe("probability()", () => {
    it("returns 0.5 when θ equals difficulty", () => {
      expect(probability(0, 0)).to.equal(0.5);
      expect(probability(1.5, 1.5)).to.equal(0.5);
    });

    it("returns > 0.5 when θ > difficulty", () => {
      expect(probability(2, 0)).to.be.greaterThan(0.5);
    });

    it("returns < 0.5 when θ < difficulty", () => {
      expect(probability(-1, 0)).to.be.lessThan(0.5);
    });

    it("approaches 1 for very high θ", () => {
      expect(probability(10, 0)).to.be.greaterThan(0.99);
    });

    it("approaches 0 for very low θ", () => {
      expect(probability(-10, 0)).to.be.lessThan(0.01);
    });
  });

  describe("createIRTState()", () => {
    it("initializes with θ=0, se=Infinity, empty responses", () => {
      const state = createIRTState();
      expect(state.theta).to.equal(0);
      expect(state.se).to.equal(Infinity);
      expect(state.responses).to.have.length(0);
      expect(state.converged).to.be.false;
    });
  });

  describe("updateAbility()", () => {
    it("increases θ after correct answer", () => {
      let state = createIRTState();
      state = updateAbility(state, 0, true, 80, "Apply");
      expect(state.theta).to.be.greaterThan(0);
    });

    it("decreases θ after incorrect answer", () => {
      let state = createIRTState();
      state = updateAbility(state, 0, false, 20, "Apply");
      expect(state.theta).to.be.lessThan(0);
    });

    it("converges to high θ when all answers are correct", () => {
      let state = createIRTState();
      const difficulties = [-1, -0.5, 0, 0.5, 1, 1.5];
      for (const b of difficulties) {
        state = updateAbility(state, b, true, 90, "Apply");
      }
      expect(state.theta).to.be.greaterThan(1.5);
    });

    it("converges to low θ when all answers are wrong", () => {
      let state = createIRTState();
      const difficulties = [1, 0.5, 0, -0.5, -1, -1.5];
      for (const b of difficulties) {
        state = updateAbility(state, b, false, 10, "Apply");
      }
      expect(state.theta).to.be.lessThan(-1.5);
    });

    it("converges near 0 for mixed responses at b=0", () => {
      let state = createIRTState();
      // Alternate correct/incorrect at same difficulty
      for (let i = 0; i < 6; i++) {
        state = updateAbility(state, 0, i % 2 === 0, i % 2 === 0 ? 70 : 30, "Apply");
      }
      expect(Math.abs(state.theta)).to.be.lessThan(1);
    });

    it("SE decreases as more responses are added", () => {
      let state = createIRTState();
      let prevSE = Infinity;
      for (let i = 0; i < 5; i++) {
        state = updateAbility(state, 0, i % 2 === 0, 50, "Apply");
        expect(state.se).to.be.lessThan(prevSE);
        prevSE = state.se;
      }
    });

    it("marks converged after SE drops below threshold with min questions", () => {
      let state = createIRTState();
      // Add many responses at varying difficulties to reduce SE
      for (let i = 0; i < 10; i++) {
        state = updateAbility(state, (i - 5) * 0.3, i % 2 === 0, 50, "Apply");
      }
      // With 10 items, SE should be small enough
      expect(state.responses.length).to.be.greaterThanOrEqual(3);
    });

    it("converges (SE < 0.40) within 22 well-targeted items", () => {
      let state = createIRTState();
      // All items at b = θ give maximum Fisher Information (I = 0.25 each).
      // SE = 1/sqrt(n*0.25 + 1). For SE < 0.40: n ≥ 22.
      // With 22 items + N(0,1) prior: total I = 22*0.25 + 1 = 6.5 → SE ≈ 0.392 < 0.40
      for (let i = 0; i < 22; i++) {
        const b = state.theta; // optimal: b = θ exactly
        const correct = i % 2 === 0;
        state = updateAbility(state, b, correct, correct ? 70 : 30, "Apply");
      }
      expect(state.se).to.be.lessThan(0.40);
      expect(state.converged).to.be.true;
    });

    it("marks converged after max questions regardless of SE", () => {
      let state = createIRTState();
      // All correct at same difficulty — SE stays high but max questions reached
      for (let i = 0; i < 15; i++) {
        state = updateAbility(state, 0, true, 90, "Apply");
      }
      expect(state.converged).to.be.true;
      expect(state.responses.length).to.equal(15);
    });
  });

  describe("selectNextDifficulty()", () => {
    it("returns difficulty near current θ", () => {
      let state = createIRTState();
      state = updateAbility(state, 0, true, 80, "Apply");
      const nextB = selectNextDifficulty(state);
      expect(Math.abs(nextB - state.theta)).to.be.lessThan(0.5);
    });

    it("stays within bounds [-3, 3]", () => {
      let state = createIRTState();
      // Push θ high
      for (let i = 0; i < 10; i++) {
        state = updateAbility(state, i * 0.3, true, 90, "Apply");
      }
      const nextB = selectNextDifficulty(state);
      expect(nextB).to.be.at.most(3);
      expect(nextB).to.be.at.least(-3);
    });

    it("targets near θ without streak offset (pure IRT)", () => {
      let state = createIRTState();
      // 5 correct in a row — should NOT add a streak bonus
      for (let i = 0; i < 5; i++) {
        state = updateAbility(state, i * 0.3, true, 90, "Apply");
      }
      // Run 20 times — all should be within ±0.2 of θ (jitter only)
      for (let t = 0; t < 20; t++) {
        const nextB = selectNextDifficulty(state);
        expect(Math.abs(nextB - state.theta)).to.be.lessThan(0.3);
      }
    });
  });

  describe("difficultyToBloom()", () => {
    it("maps difficulty ranges to correct Bloom levels", () => {
      expect(difficultyToBloom(-2)).to.equal("Remember");
      expect(difficultyToBloom(-0.5)).to.equal("Understand");
      expect(difficultyToBloom(0.2)).to.equal("Apply");
      expect(difficultyToBloom(0.7)).to.equal("Analyze");
      expect(difficultyToBloom(1.2)).to.equal("Evaluate");
      expect(difficultyToBloom(2)).to.equal("Create");
    });
  });

  describe("bloomToDifficulty()", () => {
    it("maps Bloom levels to midpoint difficulties", () => {
      expect(bloomToDifficulty("Remember")).to.equal(-1.5);
      expect(bloomToDifficulty("Apply")).to.equal(0.25);
      expect(bloomToDifficulty("Create")).to.equal(1.75);
    });
  });

  describe("thetaToScore()", () => {
    it("maps θ=0 to score=50", () => {
      expect(thetaToScore(0)).to.equal(50);
    });

    it("maps θ=-4 to score=0", () => {
      expect(thetaToScore(-4)).to.equal(0);
    });

    it("maps θ=4 to score=100", () => {
      expect(thetaToScore(4)).to.equal(100);
    });

    it("clamps extreme values", () => {
      expect(thetaToScore(-10)).to.equal(0);
      expect(thetaToScore(10)).to.equal(100);
    });

    it("clamps theta outside [-4, 4] from allCorrect/allWrong branches", () => {
      expect(thetaToScore(-5.5)).to.equal(0);
      expect(thetaToScore(6.2)).to.equal(100);
      expect(thetaToScore(-4)).to.equal(0);
      expect(thetaToScore(4)).to.equal(100);
    });
  });

  describe("probability() numerical stability", () => {
    it("saturates to the upper asymptote d for extreme positive z without NaN", () => {
      const p = probability(600, 0);
      expect(Number.isFinite(p)).to.be.true;
      expect(p).to.equal(1);
      expect(probability(600, 0, 1, 0.25, 0.95)).to.equal(0.95);
    });

    it("saturates to the lower asymptote c for extreme negative z without NaN", () => {
      const p = probability(-600, 0);
      expect(Number.isFinite(p)).to.be.true;
      expect(p).to.equal(0);
      expect(probability(-600, 0, 1, 0.25, 1)).to.equal(0.25);
    });

    it("stays strictly inside (c, d) for moderate z", () => {
      const p = probability(3, 0, 1.5, 0.2, 0.98);
      expect(p).to.be.greaterThan(0.2);
      expect(p).to.be.lessThan(0.98);
    });
  });

  describe("updateAbility() edge cases", () => {
    it("handles adversarial alternating pattern without divergence", () => {
      let state = createIRTState();
      // Alternate correct at high difficulty, wrong at low difficulty
      for (let i = 0; i < 10; i++) {
        if (i % 2 === 0) {
          state = updateAbility(state, 2, true, 80, "Create");
        } else {
          state = updateAbility(state, -2, false, 10, "Remember");
        }
      }
      expect(Number.isFinite(state.theta)).to.be.true;
      expect(Number.isFinite(state.se)).to.be.true;
      expect(state.theta).to.be.within(-4, 4);
    });
  });

  describe("isConverged()", () => {
    it("returns false for fresh state", () => {
      expect(isConverged(createIRTState())).to.be.false;
    });
  });
});

describe("difficulty setting (config.difficulty → target offset)", () => {
  const concepts = (...imps: number[]) => new Map(imps.map((importance, i) => [`c${i}`, {
    conceptId: `c${i}`, label: `C${i}`, importance, status: "untested" as const, askCount: 0,
  }]));

  it("maps the UI presets to concrete offsets", () => {
    expect(difficultyOffset(0.2)).to.be.closeTo(-0.875, 1e-9);  // easy
    expect(difficultyOffset(0.4)).to.be.closeTo(-0.375, 1e-9);  // medium
    expect(difficultyOffset(0.65)).to.be.closeTo(0.25, 1e-9);   // hard
    expect(difficultyOffset(0.5)).to.be.closeTo(-0.125, 1e-9);  // SDK default
    expect(difficultyOffset(undefined)).to.equal(0);
    expect(difficultyOffset(NaN)).to.equal(0);
    expect(difficultyOffset(-5)).to.be.closeTo(-1.375, 1e-9);   // input clamped to [0,1]
    expect(difficultyOffset(5)).to.be.closeTo(1.125, 1e-9);
  });

  it("shifts the first target: easy/medium → Understand (easy lower), hard → Apply", () => {
    const at = (d: number) => selectNextQuestion(createIRTState(), concepts(0.9, 0.7), difficultyOffset(d));
    // θ = 0, importance 0.9 → nudge 0.3 × 0.4 = 0.12
    expect(at(0.2).b_target).to.be.closeTo(-0.755, 1e-9);
    expect(at(0.2).bloomTarget).to.equal("Understand");
    expect(at(0.4).b_target).to.be.closeTo(-0.255, 1e-9);
    expect(at(0.4).bloomTarget).to.equal("Understand");
    expect(at(0.65).b_target).to.be.closeTo(0.37, 1e-9);
    expect(at(0.65).bloomTarget).to.equal("Apply");
    expect(selectNextQuestion(createIRTState(), concepts(0.9)).b_target).to.be.closeTo(0.12, 1e-9);
  });

  it("still adapts to θ (damped by half), also in Fisher mode, and clamps to [−2, 2]", () => {
    const high = { ...createIRTState(), theta: 1.0 };
    const low = { ...createIRTState(), theta: -1.0 };
    const off = difficultyOffset(0.2);
    const hi = selectNextQuestion(high, concepts(0.9), off).b_target;
    const lo = selectNextQuestion(low, concepts(0.9), off).b_target;
    expect(hi - lo).to.be.closeTo(1.0, 1e-9); // Δθ = 2 → Δtarget = 1
    // Fisher mode (no tracked concepts): offset + θ/2
    expect(selectNextQuestion(high, new Map(), off).b_target).to.be.closeTo(-0.375, 1e-9);
    expect(selectNextQuestion({ ...createIRTState(), theta: 2 }, concepts(1.0), difficultyOffset(1)).b_target).to.equal(2);
    expect(selectNextQuestion({ ...createIRTState(), theta: -2 }, new Map(), difficultyOffset(0)).b_target).to.equal(-2);
  });

  it("anchors the LLM difficulty rating to the target (±0.25), falling back to the target", () => {
    expect(ITEM_DIFFICULTY_MAX_DEVIATION).to.equal(0.25);
    expect(anchorItemDifficulty(1.0, -0.6)).to.be.closeTo(-0.35, 1e-9);  // over-rated
    expect(anchorItemDifficulty(-2, 0.5)).to.be.closeTo(0.25, 1e-9);     // under-rated
    expect(anchorItemDifficulty(0.1, 0.0)).to.be.closeTo(0.1, 1e-9);     // within band
    expect(anchorItemDifficulty(NaN, 0.3)).to.equal(0.3);
    expect(anchorItemDifficulty(undefined, -0.4)).to.equal(-0.4);
    expect(anchorItemDifficulty(5, 1.9)).to.equal(2);                    // [−2, 2]
    const once = anchorItemDifficulty(1.0, -0.6);
    expect(anchorItemDifficulty(once, -0.6)).to.equal(once);             // idempotent
  });

  describe("simulated sessions (6 important concepts, 4PL update, anchored LLM rating)", () => {
    const BLOOMS = ["Remember", "Understand", "Apply", "Analyze", "Evaluate", "Create"];
    const rank = (b: string) => BLOOMS.indexOf(b);
    /** Bloom target of each question for a learner answering per `correct`, LLM rating per `rate`. */
    function simulate(difficulty: number, n: number, correct: (i: number) => boolean, rate: (t: number) => number): string[] {
      const cm = concepts(0.95, 0.9, 0.85, 0.8, 0.75, 0.7);
      let st = createIRTState();
      const blooms: string[] = [];
      for (let i = 0; i < n; i++) {
        const t = selectNextQuestion(st, cm, difficultyOffset(difficulty));
        blooms.push(t.bloomTarget);
        const ok = correct(i);
        if (t.targetConceptId) {
          const c = cm.get(t.targetConceptId)!;
          const asked = c.askCount + 1;
          cm.set(c.conceptId, { ...c, askCount: asked, status: ok ? "mastered" : asked >= 3 ? "failed_final" : "failed" });
        }
        const b = anchorItemDifficulty(rate(t.b_target), t.b_target);
        st = updateAbility4PL(st, b, 2, t.b_target < -0.5 ? 0.5 : t.b_target < 0.5 ? 0.25 : 0, 1, ok, ok ? 100 : 0, t.bloomTarget);
      }
      return blooms;
    }
    const raters = { "LLM rates 1.0": () => 1.0, "LLM rates at target": (t: number) => t };
    const allCorrect = () => true;

    for (const [name, rate] of Object.entries(raters)) {
      it(`easy stays on Remember/Understand for a strong learner (${name})`, () => {
        const blooms = simulate(0.2, 10, allCorrect, rate);
        for (const b of blooms) expect(rank(b), blooms.join(",")).to.be.at.most(rank("Apply"));
        for (const b of blooms.slice(0, 5)) expect(["Remember", "Understand"]).to.include(b);
      });

      it(`medium tops out around Analyze within 5 questions (${name})`, () => {
        const blooms = simulate(0.4, 5, allCorrect, rate);
        expect(blooms[0]).to.equal("Understand");
        for (const b of blooms) expect(rank(b), blooms.join(",")).to.be.at.most(rank("Analyze"));
      });

      it(`hard climbs to Analyze for a strong learner; targets are capped there (never Evaluate/Create) (${name})`, () => {
        const blooms = simulate(0.65, 10, allCorrect, rate);
        expect(rank(blooms[0])).to.be.at.most(rank("Apply"));
        expect(blooms).to.include("Analyze");
        expect(blooms).to.not.include("Evaluate");
        expect(blooms).to.not.include("Create");
      });

      it(`a struggling learner never gets harder items and ends on Remember/Understand (${name})`, () => {
        for (const d of [0.2, 0.4, 0.65]) {
          const blooms = simulate(d, 10, () => false, rate);
          for (let i = 1; i < blooms.length; i++) {
            expect(rank(blooms[i]), `${d}: ${blooms.join(",")}`).to.be.at.most(rank(blooms[i - 1]));
          }
          expect(rank(blooms[9]), `${d}: ${blooms.join(",")}`).to.be.at.most(rank("Understand"));
        }
      });
    }
  });
});
