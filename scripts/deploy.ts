import hre from "hardhat";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

function extractSuggestedNonce(err: unknown): number | null {
  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(/next nonce\s+(\d+)/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

async function main() {
  const networkName = hre.network.name;
  const chainId = await hre.ethers.provider.getNetwork().then(n => Number(n.chainId));
  const [deployer, secondary] = await hre.ethers.getSigners();
  let nextNonce = await hre.ethers.provider.getTransactionCount(deployer.address, "pending");

  let oracleAddress: string;
  if (networkName === "hardhat") {
    oracleAddress = deployer.address;
  } else if (networkName === "localhost") {
    oracleAddress = secondary?.address || deployer.address;
  } else {
    oracleAddress = process.env.ORACLE_ADDRESS || "";
    if (!oracleAddress) {
      throw new Error("ORACLE_ADDRESS missing for base-sepolia deployment");
    }
  }

  console.log(`Deploying with ${deployer.address} to ${networkName} (chainId ${chainId})`);
  console.log(`Oracle address: ${oracleAddress}`);
  console.log(`Starting nonce: ${nextNonce}`);

  async function withNonceRetry<T>(label: string, fn: (nonce: number) => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const useNonce = nextNonce;
      try {
        const out = await fn(useNonce);
        nextNonce = useNonce + 1;
        return out;
      } catch (err) {
        const suggested = extractSuggestedNonce(err);
        if (suggested !== null && suggested > nextNonce) {
          console.warn(`${label}: nonce ${nextNonce} too low, retrying with ${suggested}`);
          nextNonce = suggested;
          continue;
        }
        throw err;
      }
    }
    throw new Error(`${label}: failed after nonce retries`);
  }

  const PoCW_SBT = await hre.ethers.getContractFactory("PoCW_SBT");
  const sbt = await withNonceRetry("PoCW_SBT.deploy", async (nonce) =>
    PoCW_SBT.deploy({ nonce })
  );
  await sbt.waitForDeployment();
  const sbtAddress = await sbt.getAddress();
  console.log(`PoCW_SBT deployed at ${sbtAddress}`);

  // strictSender=true on public networks; false on local nodes for easier testing
  const strictSender = networkName !== "hardhat" && networkName !== "localhost";

  const PoCW_Controller = await hre.ethers.getContractFactory("PoCW_Controller");
  const controller = await withNonceRetry("PoCW_Controller.deploy", async (nonce) =>
    PoCW_Controller.deploy(oracleAddress, sbtAddress, strictSender, { nonce })
  );
  await controller.waitForDeployment();
  const controllerAddress = await controller.getAddress();
  console.log(`PoCW_Controller deployed at ${controllerAddress} (strictSender=${strictSender})`);

  const tx = await withNonceRetry("PoCW_SBT.transferOwnership", async (nonce) =>
    sbt.transferOwnership(controllerAddress, { nonce })
  );
  await tx.wait();
  console.log("Transferred SBT ownership to controller");

  // Write deployment record for frontend + oracle config
  const deploymentsDir = path.resolve(__dirname, "..", "deployments");
  fs.mkdirSync(deploymentsDir, { recursive: true });

  const record = {
    chainId,
    network: networkName,
    controllerAddress,
    sbtAddress,
    oracleAddress,
    strictSender,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
  };

  const outPath = path.join(deploymentsDir, `${networkName}.json`);
  fs.writeFileSync(outPath, JSON.stringify(record, null, 2));
  console.log(`Deployment record written to ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
