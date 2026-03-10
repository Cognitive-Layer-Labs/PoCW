import hre from "hardhat";
import { ethers } from "hardhat";
import readline from "readline";

import {
  generateChallenge,
  recordAnswers,
  verifyChallenge,
  __clearChallengesForTest
} from "../oracle-service/src/services/ai-engine";

/* helper ca sa citim input din terminal */
function ask(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  __clearChallengesForTest();

  /* conectare la hardhat node */
  const [deployer, oracle, user] = await hre.ethers.getSigners();

  console.log("\n=== ACTORS ===");
  console.log("Oracle:", oracle.address);
  console.log("User:  ", user.address);

  /* deploy SBT */
  const SBT = await hre.ethers.getContractFactory("PoCW_SBT");
  const sbt = await SBT.deploy();
  await sbt.waitForDeployment();

  /* deploy controller */
  const Controller = await hre.ethers.getContractFactory("PoCW_Controller");
  const controller = await Controller.deploy(
    oracle.address,
    await sbt.getAddress()
  );
  await controller.waitForDeployment();

  await sbt.transferOwnership(await controller.getAddress());

  console.log("\nContracts deployed");

  /* === AI REAL === */
  const contentUrl = "https://bitcoin.org/bitcoin.pdf";

  console.log("\n=== GENERATING QUESTIONS ===");
  const challenge = await generateChallenge(contentUrl, user.address);

  console.log("\nQUESTIONS:");
  challenge.questions.forEach((q, i) => {
    console.log(`Q${i + 1}: ${q}`);
  });

  console.log("\n=== WRITE YOUR ANSWERS ===");

  const answers: string[] = [];
  for (let i = 0; i < challenge.questions.length; i++) {
    const answer = await ask(`Answer Q${i + 1}: `);
    answers.push(answer);
  }

  recordAnswers(challenge.challengeId, answers);

  console.log("\n=== GRADING (AI REAL) ===");
  const score = await verifyChallenge(challenge.challengeId);
  console.log("Score received:", score);

  console.log("\n=== MINTING SBT ===");

  const hash = ethers.solidityPackedKeccak256(
    ["address", "uint256", "uint256"],
    [user.address, challenge.contentId, score]
  );

  const signature = await oracle.signMessage(ethers.getBytes(hash));

  await controller.verifyAndMint(
    user.address,
    challenge.contentId,
    score,
    signature
  );

  const balance = await sbt.balanceOf(user.address, challenge.contentId);
  console.log("SBT balance:", balance.toString());

  console.log("\n✅ FLOW COMPLETED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
