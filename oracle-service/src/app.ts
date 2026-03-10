import express, { Request, Response } from "express";
import { Challenge, generateChallenge, recordAnswers, verifyChallenge } from "./services/ai-engine";
import { signResult, getOracleAddress } from "./services/signer";

const app = express();
app.use(express.json());

const challenges = new Map<string, Challenge>();

app.post("/generate-challenge", async (req: Request, res: Response) => {
  const { contentUrl, userAddress } = req.body || {};
  if (!contentUrl || !userAddress) {
    return res.status(400).json({ error: "contentUrl and userAddress required" });
  }

  try {
    const challenge = await generateChallenge(contentUrl, userAddress);
    challenges.set(challenge.challengeId, challenge);
    return res.json({
      challengeId: challenge.challengeId,
      contentId: challenge.contentId,
      questions: challenge.questions
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/submit-challenge", async (req: Request, res: Response) => {
  const { challengeId, userAnswers, userAddress } = req.body || {};
  if (!challengeId || !userAddress || !Array.isArray(userAnswers)) {
    return res
      .status(400)
      .json({ error: "challengeId, userAddress and userAnswers[] required" });
  }

  const challenge = challenges.get(challengeId);
  if (!challenge) {
    return res.status(404).json({ error: "challenge not found" });
  }
  if (challenge.userAddress.toLowerCase() !== String(userAddress).toLowerCase()) {
    return res.status(403).json({ error: "user mismatch" });
  }

  try {
    recordAnswers(challengeId, userAnswers);
    const score = await verifyChallenge(challengeId);
    const signature = await signResult(challenge.userAddress, challenge.contentId, score);
    return res.json({
      status: "success",
      score,
      signature,
      contentId: challenge.contentId,
      oracle: getOracleAddress()
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default app;

