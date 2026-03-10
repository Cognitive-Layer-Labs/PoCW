import hre from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const networkName = hre.network.name;
  const [deployer, secondary] = await hre.ethers.getSigners();

  let oracleAddress: string;
  if (networkName === "hardhat") {
    oracleAddress = deployer.address; // use first signer locally
  } else if (networkName === "localhost") {
    oracleAddress = secondary?.address || deployer.address;
  } else {
    oracleAddress = process.env.ORACLE_ADDRESS || "";
    if (!oracleAddress) {
      throw new Error("ORACLE_ADDRESS missing for base-sepolia deployment");
    }
  }

  console.log(`Deploying with ${deployer.address} to ${networkName}`);
  console.log(`Oracle address: ${oracleAddress}`);

  const PoCW_SBT = await hre.ethers.getContractFactory("PoCW_SBT");
  const sbt = await PoCW_SBT.deploy();
  await sbt.waitForDeployment();
  const sbtAddress = await sbt.getAddress();
  console.log(`PoCW_SBT deployed at ${sbtAddress}`);

  const PoCW_Controller = await hre.ethers.getContractFactory("PoCW_Controller");
  const controller = await PoCW_Controller.deploy(oracleAddress, sbtAddress);
  await controller.waitForDeployment();
  const controllerAddress = await controller.getAddress();
  console.log(`PoCW_Controller deployed at ${controllerAddress}`);

  // Give minting control to the controller
  const tx = await sbt.transferOwnership(controllerAddress);
  await tx.wait();
  console.log("Transferred SBT ownership to controller");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

