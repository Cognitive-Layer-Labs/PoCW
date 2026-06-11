/**
 * Resolves on-chain addresses + chainId for EIP-712 signing and access checks.
 * Order of precedence: explicit env var → deployments/<DEPLOY_NETWORK>.json.
 */
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "..", "..", "..", ".env") });

const NETWORK = process.env.DEPLOY_NETWORK || "base-sepolia";

interface DeploymentRecord {
  chainId?: number;
  controllerAddress?: string;
  sbtAddress?: string;
  kalAddress?: string;
  paywallAddress?: string;
}

let _record: DeploymentRecord | null = null;
function record(): DeploymentRecord {
  if (_record) return _record;
  try {
    const p = path.resolve(__dirname, "..", "..", "..", "deployments", `${NETWORK}.json`);
    _record = JSON.parse(fs.readFileSync(p, "utf8")) as DeploymentRecord;
  } catch {
    _record = {};
  }
  return _record;
}

export function chainId(): number | null {
  const env = process.env.CHAIN_ID;
  if (env) return Number(env);
  return record().chainId ?? null;
}
export const controllerAddress = (): string | null =>
  process.env.CONTROLLER_ADDRESS || record().controllerAddress || null;
export const sbtAddress = (): string | null =>
  process.env.SBT_ADDRESS || record().sbtAddress || null;
export const kalAddress = (): string | null =>
  process.env.KAL_ADDRESS || record().kalAddress || null;
export const paywallAddress = (): string | null =>
  process.env.PAYWALL_ADDRESS || record().paywallAddress || null;
