/**
 * PoCW Protocol — 3rd Party Integration Demo
 *
 * Demonstrates the full flow: index → verify → on-chain mint.
 * Run: npx hardhat run scripts/simulate-flow.ts --network localhost
 */

import hre from "hardhat";
import readline from "readline";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { PoCW } from "../oracle-service/src/sdk/index";
import type { VerifySession } from "../oracle-service/src/sdk/verify-session";
import type { VerifyQuestion, AnswerFeedback } from "../oracle-service/src/sdk/types";

/** Convert a local file path to a file:// URL so the oracle parser handles it. */
function resolveSource(input: string): string {
  if (input.startsWith("http://") || input.startsWith("https://") || input.startsWith("ipfs://")) {
    return input;
  }
  const absPath = path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
  return pathToFileURL(absPath).href;
}

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

function questionTypeC(type: string): number {
  if (type === "true_false") return 0.50;
  if (type === "mcq") return 0.25;
  return 0.00;
}

function printQuestionHeader(q: VerifyQuestion): void {
  const c = questionTypeC(q.type);
  console.log(`\n--- Q${q.number}/${q.totalQuestions} [${q.type}] [${q.bloomLevel}] ---`);
  console.log(`  IRT (before):  b=${q.difficulty.toFixed(3)}  c=${c}  bloom=${q.bloomLevel}`);
}

function printFeedback(fb: AnswerFeedback): void {
  const verdict = fb.correct ? "CORRECT ✓" : "WRONG ✗";
  console.log(`\n  ${verdict}  score=${fb.score}/100`);

  if (fb.irtParams) {
    const p = fb.irtParams;
    const bPred = p.b_pred !== null ? p.b_pred.toFixed(3) : "n/a";
    console.log(`  IRT update:`);
    console.log(`    a=${p.a.toFixed(3)}  b_llm=${p.b_llm.toFixed(3)}  b_pred=${bPred}  b_used=${p.b_used.toFixed(3)}  c=${p.c}  d=${p.d.toFixed(3)}`);
    console.log(`    θ  ${p.theta_before.toFixed(3)} → ${fb.progress.theta.toFixed(3)}   SE=${fb.progress.se.toFixed(3)}`);
  }

  if (fb.reasoning) {
    console.log(`\n  Reasoning: ${fb.reasoning}`);
  }

  if (fb.dimensions) {
    const dim = fb.dimensions;
    console.log(`  Coverage:  ${dim.covered_points}/${dim.total_points} key points  precision_cap=${dim.precision_cap}`);
  }

  if (fb.referenceKeyPoints && fb.referenceKeyPoints.length > 0) {
    console.log(`\n  Reference answer (key points):`);
    fb.referenceKeyPoints.forEach((kp, i) => {
      console.log(`    ${i + 1}. ${kp}`);
    });
  }
}

async function presentQuestion(q: VerifyQuestion): Promise<string> {
  printQuestionHeader(q);

  if (q.type === "mcq" && q.options) {
    console.log(`\nQ: ${q.text}\n`);
    q.options.forEach((opt, i) => {
      console.log(`  ${String.fromCharCode(65 + i)}. ${opt}`);
    });
    console.log("");
    return await ask("Your answer (A/B/C/D): ");
  }

  if (q.type === "true_false") {
    console.log(`\nStatement: ${q.text}\n`);
    return await ask("True or False: ");
  }

  console.log(`\nQ: ${q.text}\n`);
  return await ask("Your answer: ");
}

async function main() {
  /* ── Initialize PoCW SDK ── */
  const pocw = new PoCW();
  await pocw.init();

  const networkName = hre.network.name;
  const signers = await hre.ethers.getSigners();
  const [deployer] = signers;

  let controllerAddress: string;
  let sbtAddress: string;
  let userAddress: string;

  if (networkName === "localhost" || networkName === "hardhat") {
    /* ── Local: deploy fresh contracts ── */
    const oracle = signers[1];
    const user   = signers[2];
    userAddress  = user.address;

    console.log("\n=== ACTORS ===");
    console.log("Oracle:", oracle.address);
    console.log("User:  ", user.address);

    const SBT = await hre.ethers.getContractFactory("PoCW_SBT");
    const sbt = await SBT.deploy();
    await sbt.waitForDeployment();

    const Controller = await hre.ethers.getContractFactory("PoCW_Controller");
    const controller = await Controller.deploy(
      oracle.address,
      await sbt.getAddress(),
      false  // strictSender=false for local testing
    );
    await controller.waitForDeployment();
    await sbt.transferOwnership(await controller.getAddress());

    controllerAddress = await controller.getAddress();
    sbtAddress        = await sbt.getAddress();
    console.log("\nContracts deployed");
  } else {
    /* ── Testnet: read addresses from deployments/<network>.json ── */
    const recordPath = path.resolve(__dirname, "..", "deployments", `${networkName}.json`);
    if (!fs.existsSync(recordPath)) {
      throw new Error(
        `No deployment record found at ${recordPath}.\n` +
        `Run: npx hardhat run scripts/deploy.ts --network ${networkName}`
      );
    }
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    controllerAddress = record.controllerAddress;
    sbtAddress        = record.sbtAddress;
    userAddress       = deployer.address;

    console.log("\n=== ACTORS ===");
    console.log("Network:    ", networkName);
    console.log("User:       ", userAddress);
    console.log("Controller: ", controllerAddress);
    console.log("SBT:        ", sbtAddress);
  }

  /* ── Step 1: Index Content ── */
  // Use a URL or a local file path (absolute or relative to project root):
  //   const source = "/Users/you/documents/my-book.pdf";
  //   const source = "./data/my-book.pdf";
  // const source = "https://ia801309.us.archive.org/12/items/TheArtOfLoving/43799393-The-Art-of-Loving-Erich-Fromm_text.pdf";
  const source = "/Users/gabib/Downloads/Letters.pdf";

  console.log("\n=== INDEXING CONTENT ===");
  const resolvedSource = resolveSource(source);
  console.log("Source:", source);

  const indexResult = await pocw.index(resolvedSource);
  console.log("Knowledge ID:", indexResult.knowledgeId);
  console.log("Status:", indexResult.status);

  if (indexResult.status !== "ready") {
    console.log("Waiting for indexing to complete...");
    await pocw.waitForIndex(indexResult.knowledgeId);
    console.log("Indexing complete!");
  }

  /* ── Step 2: Verify (session mode) ── */
  console.log("\n=== STARTING VERIFICATION ===");
  console.log("Question types: open, mcq, true_false");

  const session = await pocw.verify(indexResult.knowledgeId, userAddress, {
    max_questions: 15,
    difficulty: 0.15,
    threshold: 0.5,
    q_types: ["open", "mcq", "true_false"],
    response: "detailed",
    attest: "onchain",
    language: "english",
    chain: { controllerAddress, sbtAddress },
  }) as VerifySession;

  while (session.isActive()) {
    const q = session.currentQuestion;
    const answer = await presentQuestion(q);
    const fb = await session.submitAnswer(answer);
    printFeedback(fb);
  }

  const result = await session.getResult();

  /* ── Print Result ── */
  console.log("\n=== COGNITIVE PROFILE ===");
  console.log(`  Score:      ${result.score}/100`);
  console.log(`  Passed:     ${result.competenceIndicator}`);
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

  /* ── Step 3: Mint SBT + KAL ── */
  if (result.attestation?.type === "onchain") {
    console.log("\n=== MINTING SBT ===");
    const att = result.attestation;

    const controller = await hre.ethers.getContractAt("PoCW_Controller", controllerAddress);
    const sbt        = await hre.ethers.getContractAt("PoCW_SBT", sbtAddress);

    await controller.verifyAndMint(
      userAddress,
      att.contentId,
      result.score,
      att.expiry,
      att.nonce,
      result.tokenUri ?? "",
      att.signature
    );

    const balance = await sbt.balanceOf(userAddress, att.contentId);
    console.log("SBT balance:", balance.toString());

    // Mint KAL
    if (result.kalAmount && result.kalAmount > 0) {
      console.log(`\n=== MINTING KAL: ${result.kalAmount} KAL ===`);
      const { ethers } = hre;
      const KAL_ABI = ["function mint(address to, uint256 amount) external"];

      // Read kalAddress from deployments record (set during deploy)
      let kalAddress: string | undefined;
      if (networkName !== "localhost" && networkName !== "hardhat") {
        const recordPath = path.resolve(__dirname, "..", "deployments", `${networkName}.json`);
        if (fs.existsSync(recordPath)) {
          kalAddress = JSON.parse(fs.readFileSync(recordPath, "utf8")).kalAddress;
        }
      } else {
        // Local: deploy fresh KAL owned by the oracle signer
        const oracle = signers[1];
        const KAL = await ethers.getContractFactory("KAL", oracle);
        const kalContract = await KAL.deploy();
        await kalContract.waitForDeployment();
        kalAddress = await kalContract.getAddress();
        console.log("KAL deployed at:", kalAddress);
      }

      if (kalAddress) {
        const oracle    = networkName === "localhost" || networkName === "hardhat" ? signers[1] : signers[0];
        const kal       = new ethers.Contract(kalAddress, KAL_ABI, oracle);
        const amountWei = ethers.parseEther(result.kalAmount.toFixed(18));
        await (kal.mint as any)(userAddress, amountWei);
        const kalContract = await ethers.getContractAt(
          ["function balanceOf(address) view returns (uint256)"],
          kalAddress
        );
        const kalBalance = await (kalContract.balanceOf as any)(userAddress);
        console.log("KAL balance:", ethers.formatEther(kalBalance), "KAL");
      }
    }
  }

  await pocw.close();
  console.log("\nFlow completed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
