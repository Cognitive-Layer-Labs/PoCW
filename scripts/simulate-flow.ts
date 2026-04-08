/**
 * PoCW Protocol — 3rd Party Integration Demo
 *
 * Demonstrates the full flow: index → verify → on-chain mint.
 * Run: npx hardhat run scripts/simulate-flow.ts --network localhost
 */

import hre from "hardhat";
import readline from "readline";
import { PoCW } from "../oracle-service/src/sdk/index";
import type { VerifyQuestion } from "../oracle-service/src/sdk/types";

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
  /* ── Initialize PoCW SDK ── */
  const pocw = new PoCW();
  await pocw.init();

  /* ── Deploy contracts ── */
  const [deployer, oracle, user] = await hre.ethers.getSigners();

  console.log("\n=== ACTORS ===");
  console.log("Oracle:", oracle.address);
  console.log("User:  ", user.address);

  const SBT = await hre.ethers.getContractFactory("PoCW_SBT");
  const sbt = await SBT.deploy();
  await sbt.waitForDeployment();

  const Controller = await hre.ethers.getContractFactory("PoCW_Controller");
  const controller = await Controller.deploy(
    oracle.address,
    await sbt.getAddress()
  );
  await controller.waitForDeployment();
  await sbt.transferOwnership(await controller.getAddress());

  console.log("\nContracts deployed");

  /* ── Step 1: Index Content ── */
  const contentUrl = "https://amiciiisteti.wordpress.com/wp-content/uploads/2017/01/ursul-pacalit-de-vulpe.pdf";

  console.log("\n=== INDEXING CONTENT ===");
  console.log("Source:", contentUrl);

  const indexResult = await pocw.index(contentUrl);
  console.log("Knowledge ID:", indexResult.knowledgeId);
  console.log("Status:", indexResult.status);

  if (indexResult.status !== "ready") {
    console.log("Waiting for indexing to complete...");
    await pocw.waitForIndex(indexResult.knowledgeId);
    console.log("Indexing complete!");
  }

  /* ── Step 2: Verify (callback mode) ── */
  console.log("\n=== STARTING VERIFICATION ===");
  console.log("Question types: open, mcq, true_false");
  console.log("");

  const result = await pocw.verify(indexResult.knowledgeId, user.address, {
    max_questions: 7,
    difficulty: 0.15,
    threshold: 0.5,
    q_types: ["open", "mcq", "true_false"],
    response: "detailed",
    attest: "onchain",
    language: "romanian",
    chain: {
      controllerAddress: await controller.getAddress(),
      sbtAddress: await sbt.getAddress(),
    },
    onQuestion: async (q: VerifyQuestion) => {
      console.log(`--- Q${q.number}/${q.totalQuestions} [${q.type}] [${q.bloomLevel}] (d: ${q.difficulty.toFixed(2)}) ---`);

      if (q.type === "mcq" && q.options) {
        console.log(`Q: ${q.text}\n`);
        q.options.forEach((opt, i) =>
          console.log(`  ${String.fromCharCode(65 + i)}. ${opt}`)
        );
        console.log("");
        return await ask("Your answer (A/B/C/D): ");
      }

      if (q.type === "true_false") {
        console.log(`Statement: ${q.text}\n`);
        return await ask("True or False: ");
      }

      // open or scenario
      console.log(`Q: ${q.text}\n`);
      return await ask("Your answer: ");
    }
  });

  /* ── Print Result ── */
  console.log("\n=== COGNITIVE PROFILE ===");
  console.log(`  Score:      ${result.score}/100`);
  console.log(`  Passed:     ${result.passed}`);
  console.log(`  Theta:      ${result.theta.toFixed(3)}`);
  console.log(`  SE:         ${result.se.toFixed(3)}`);
  console.log(`  Converged:  ${result.converged}`);
  console.log(`  CI:         [${result.confidence_interval[0]}, ${result.confidence_interval[1]}]`);
  console.log(`  Questions:  ${result.questions_asked}`);

  if (result.response_detail) {
    console.log("\n  Breakdown:");
    for (const q of result.response_detail) {
      console.log(`    [${q.type}] ${q.correct ? "CORRECT" : "WRONG"} (${q.score}/100) - ${q.bloomLevel}`);
    }
  }

  /* ── Step 3: Mint SBT ── */
  if (result.attestation?.type === "onchain") {
    console.log("\n=== MINTING SBT ===");
    const att = result.attestation;

    await controller.verifyAndMint(
      user.address,
      att.contentId,
      result.score,
      att.signature
    );

    const balance = await sbt.balanceOf(user.address, att.contentId);
    console.log("SBT balance:", balance.toString());
  }

  await pocw.close();
  console.log("\nFlow completed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
