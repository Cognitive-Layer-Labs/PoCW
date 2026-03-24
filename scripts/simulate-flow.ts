import hre from "hardhat";
import { ethers } from "hardhat";
import readline from "readline";

import {
  createSession,
  submitAnswer,
  getSessionResult,
  __clearSessionsForTest
} from "../oracle-service/src/services/session-manager";
import { initNeo4j, closeNeo4j } from "../oracle-service/src/services/kg-store";
import { thetaToScore } from "../oracle-service/src/services/irt-engine";

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
  __clearSessionsForTest();
  initNeo4j();

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

  /* === ADAPTIVE TESTING FLOW === */
  // const contentUrl = "https://bitcoin.org/bitcoin.pdf";
  const contentUrl = "https://microsoft.github.io/Web-Dev-For-Beginners/pdf/readme.pdf";
  // const contentUrl = "https://ia902903.us.archive.org/13/items/letterstoayoungpoetpdfdrive.com/Letters%20to%20a%20Young%20Poet%20%28%20PDFDrive.com%20%29.pdf";

  console.log("\n=== STARTING ADAPTIVE SESSION ===");
  console.log("Building knowledge graph & generating first question...\n");

  const session = await createSession(contentUrl, user.address);
  let questionNumber = 1;
  let currentQuestion = session.question;
  let converged = false;

  while (!converged) {
    console.log(`--- Question ${questionNumber} [${currentQuestion.bloomLevel}] (difficulty: ${currentQuestion.difficulty.toFixed(2)}) ---`);
    console.log(`Q: ${currentQuestion.question}\n`);

    const answer = await ask(`Your answer: `);

    console.log("\nGrading...");
    const result = await submitAnswer(session.sessionId, answer);

    console.log(`  Score: ${result.gradeResult.score}/100 (${result.gradeResult.correct ? "CORRECT" : "INCORRECT"})`);
    const d = result.gradeResult.dimensions;
    console.log(`    Accuracy: ${d.accuracy}/25 | Depth: ${d.depth}/25 | Specificity: ${d.specificity}/25 | Reasoning: ${d.reasoning}/25`);
    console.log(`  ${result.gradeResult.reasoning}`);
    console.log(`  θ = ${result.progress.currentTheta.toFixed(3)}, SE = ${result.progress.currentSE.toFixed(3)}, Level: ${result.progress.bloomLevel}`);

    if (result.status === "converged") {
      converged = true;
      console.log(`\n=== CONVERGED after ${result.progress.questionNumber} questions ===`);
    } else {
      currentQuestion = result.nextQuestion!;
      questionNumber++;
      console.log("");
    }
  }

  /* === GET RESULT === */
  console.log("\n=== COGNITIVE PROFILE ===");
  const finalResult = await getSessionResult(session.sessionId);

  console.log(`  Final θ:    ${finalResult.theta.toFixed(3)}`);
  console.log(`  Score:      ${finalResult.score}/100`);
  console.log(`  Questions:  ${finalResult.cognitiveProfile.questionCount}`);
  console.log(`  Bloom's:    ${finalResult.cognitiveProfile.bloomLevelsReached.join(", ") || "none"}`);
  console.log(`  IPFS hash:  ${finalResult.ipfsHash}`);

  const score = finalResult.score;

  console.log("\n=== MINTING SBT ===");

  const hash = ethers.solidityPackedKeccak256(
    ["address", "uint256", "uint256"],
    [user.address, session.contentId, score]
  );

  const signature = await oracle.signMessage(ethers.getBytes(hash));

  await controller.verifyAndMint(
    user.address,
    session.contentId,
    score,
    signature
  );

  const balance = await sbt.balanceOf(user.address, session.contentId);
  console.log("SBT balance:", balance.toString());

  await closeNeo4j();

  console.log("\n✅ FLOW COMPLETED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
