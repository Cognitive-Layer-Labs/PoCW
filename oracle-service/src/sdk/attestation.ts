/**
 * Attestation Strategies
 *
 * Handles signing verification results for on-chain or off-chain attestation.
 * The SDK returns signatures — it never sends transactions.
 */

import { signResult, getOracleAddress } from "../services/signer";
import {
  AttestationResult,
  OnchainAttestation,
  OffchainAttestation,
  ChainConfig,
  PoCWError,
} from "./types";

/**
 * Create an off-chain attestation (oracle signature only).
 */
export async function attestOffchain(
  subject: string,
  contentId: number,
  score: number
): Promise<OffchainAttestation> {
  try {
    const signature = await signResult(subject, contentId, score);
    return {
      type: "offchain",
      signature,
      contentId,
      score,
      oracle: getOracleAddress(),
    };
  } catch (err) {
    throw new PoCWError(
      "ATTESTATION_ERROR",
      "Failed to sign off-chain attestation",
      err instanceof Error ? err : undefined
    );
  }
}

/**
 * Create an on-chain attestation (oracle signature + contract info).
 * The caller is responsible for submitting the transaction.
 */
export async function attestOnchain(
  subject: string,
  contentId: number,
  score: number,
  chain: ChainConfig
): Promise<OnchainAttestation> {
  try {
    const signature = await signResult(subject, contentId, score);
    return {
      type: "onchain",
      signature,
      contentId,
      score,
      oracle: getOracleAddress(),
      controllerAddress: chain.controllerAddress,
      sbtAddress: chain.sbtAddress,
    };
  } catch (err) {
    throw new PoCWError(
      "ATTESTATION_ERROR",
      "Failed to sign on-chain attestation",
      err instanceof Error ? err : undefined
    );
  }
}

/**
 * Build attestation based on config.
 */
export async function buildAttestation(
  attest: "onchain" | "offchain" | "none",
  subject: string,
  contentId: number,
  score: number,
  chain?: ChainConfig
): Promise<AttestationResult | undefined> {
  switch (attest) {
    case "none":
      return undefined;
    case "offchain":
      return attestOffchain(subject, contentId, score);
    case "onchain":
      if (!chain) {
        throw new PoCWError("INVALID_CONFIG", "chain config required for on-chain attestation");
      }
      return attestOnchain(subject, contentId, score, chain);
  }
}
