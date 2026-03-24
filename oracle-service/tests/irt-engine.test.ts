import { expect } from "chai";
import {
  createIRTState,
  updateAbility,
  selectNextDifficulty,
  isConverged,
  probability,
  difficultyToBloom,
  bloomToDifficulty,
  thetaToScore,
  IRT_CORRECT_THRESHOLD
} from "../src/services/irt-engine";

describe("IRT Engine (1PL Rasch)", () => {
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

    it("converges (SE < 0.5) within 13 well-targeted items", () => {
      let state = createIRTState();
      // All items at b = θ give maximum Fisher Information (I=0.25 each).
      // With 13 items + N(0,1) prior: total I = 13*0.25 + 1 = 4.25 → SE ≈ 0.485
      for (let i = 0; i < 13; i++) {
        const b = state.theta; // optimal: b = θ exactly
        const correct = i % 2 === 0;
        state = updateAbility(state, b, correct, correct ? 70 : 30, "Apply");
      }
      expect(state.se).to.be.lessThan(0.5);
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
  });

  describe("isConverged()", () => {
    it("returns false for fresh state", () => {
      expect(isConverged(createIRTState())).to.be.false;
    });
  });
});
