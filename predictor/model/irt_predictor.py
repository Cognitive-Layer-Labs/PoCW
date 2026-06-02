#!/usr/bin/env python3
"""
irt_predictor.py — IRT Parameter Predictor
Generat automat de train_irt_predictor.py

Usage:
    from irt_predictor import IRTPredictor
    p = IRTPredictor()
    result = p.predict("Ce este fotosinteza?", ["A...", "B...", "C...", "D..."])
    # result: {"a": 1.2, "b": 0.3, "c": 0.25, "d": 0.95, "p_avg_student": 0.61}
"""

import math
import numpy as np
from pathlib import Path


class IRTPredictor:
    """
    Predictor IRT 2PL din text.
    Parametri returnați:
      a  — discrimination: cât de bine separă cei care știu de cei care nu știu
      b  — difficulty: pragul theta la care P(corect) = 0.5 (2PL: c=0, d=1)
      c  — guessing: deterministic din tipul întrebării (mc=0.25, tf=0.5, open=0)
      d  — upper asymptote: constant 1.0 (fix 2PL)
    """

    def __init__(self, model_dir: str = "."):
        import joblib
        from sentence_transformers import SentenceTransformer

        model_dir = Path(model_dir)
        regressors_path = model_dir / "xgb_regressors.pkl"
        if not regressors_path.exists():
            regressors_path = Path(__file__).parent / "xgb_regressors.pkl"

        self.regressors = joblib.load(regressors_path)
        self.embedder = SentenceTransformer("BAAI/bge-small-en-v1.5")
        self._text_feature_names = [
            "question_len", "n_words", "n_choices_chars",
            "has_not", "has_always", "has_never",
            "has_which", "has_what", "has_why", "has_how",
        ]

    def _text_features(self, question: str, choices: list) -> np.ndarray:
        text = question
        words = text.lower().split()
        return np.array([[
            len(text), len(words), sum(len(c) for c in choices),
            int("not" in words or "n't" in text.lower()),
            int("always" in words), int("never" in words),
            int("which" in words), int("what" in words),
            int("why" in words), int("how" in words),
        ]], dtype=np.float32)

    def predict(
        self,
        question: str,
        choices: list[str] = None,
        theta: float = 0.0,
    ) -> dict:
        """
        Prezice parametrii IRT pentru o întrebare.

        Args:
            question: textul întrebării
            choices: lista de variante (opțional, max 4)
            theta: abilitatea examinee-ului (implicit 0.0 = student mediu)

        Returns:
            dict cu a, b, c, d, p_correct, interpretation
        """
        choices = choices or []
        choices_str = " | ".join(
            f"{l}) {c}" for l, c in zip("ABCD", choices[:4])
        )
        text = f"query: {question} {choices_str}"

        emb = self.embedder.encode([text], normalize_embeddings=True)
        text_feats = self._text_features(question, choices)
        X = np.hstack([emb, text_feats])

        params = {}
        for pname, reg in self.regressors.items():
            if isinstance(reg, dict) and reg.get("type") == "constant":
                params[pname] = reg["value"]
            else:
                params[pname] = float(reg.predict(X)[0])

        a = max(params.get("a", 1.0), 0.01)
        b = params.get("b", 0.0)
        c = max(0.0, min(0.5, params.get("c", 0.25)))
        d = max(0.5, min(1.0, params.get("d", 1.0)))

        # ICC 4PL: P(corect | theta) = c + (d-c) / (1 + exp(-a*(theta-b)))
        p_correct = c + (d - c) / (1 + math.exp(-a * (theta - b)))

        # Interpretare semantică
        difficulty_label = (
            "foarte ușoară" if b < -1.5 else
            "ușoară"        if b < -0.5 else
            "medie"         if b < 0.5  else
            "grea"          if b < 1.5  else
            "foarte grea"
        )
        disc_label = (
            "slab discriminativă" if a < 0.5 else
            "moderat"             if a < 1.0 else
            "bun discriminativă"  if a < 2.0 else
            "excelent discriminativă"
        )

        return {
            "a":              round(a, 4),   # discrimination
            "b":              round(b, 4),   # difficulty
            "c":              round(c, 4),   # guessing (lower asymptote)
            "d":              round(d, 4),   # upper asymptote
            "p_correct":      round(p_correct, 4),
            "difficulty":     difficulty_label,
            "discrimination": disc_label,
        }

    def predict_batch(self, items: list[dict]) -> list[dict]:
        """
        Prezice pentru o listă de items.
        Fiecare item: {"question": "...", "choices": ["A", "B", "C", "D"]}
        """
        return [
            self.predict(item["question"], item.get("choices", []))
            for item in items
        ]


if __name__ == "__main__":
    import json, sys
    p = IRTPredictor()

    question = sys.argv[1] if len(sys.argv) > 1 else "What is photosynthesis?"
    choices = ["A process", "A chemical", "A plant", "A cell"]
    result = p.predict(question, choices)
    print(json.dumps(result, indent=2, ensure_ascii=False))
