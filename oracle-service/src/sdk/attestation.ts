/**
 * Attestation Strategies
 *
 * Handles signing verification results for on-chain or off-chain attestation.
 * The SDK returns signatures — it never sends transactions.
 *
 * The oracle encodes ERC-1155 metadata as a base64 data URI BEFORE signing.
 * The tokenUri is included in the signed payload so the contract can verify
 * the metadata was committed before the signature was issued.
 */

import { signMintAuthorization, getOracleAddress } from "../services/signer";
import {
  AttestationResult,
  OnchainAttestation,
  OffchainAttestation,
  ChainConfig,
  PoCWError,
} from "./types";

/**
 * Create an off-chain attestation (oracle signature only, no chain config required).
 */
export async function attestOffchain(
  subject: string,
  contentId: number,
  score: number,
  tokenUri: string,
  contentHash: string
): Promise<OffchainAttestation> {
  try {
    const { signature, nonce, expiry } = await signMintAuthorization(subject, contentId, score, tokenUri);
    return {
      type: "offchain",
      signature,
      nonce,
      expiry,
      contentId,
      score: Math.round(score),
      oracle: getOracleAddress(),
      tokenUri,
      contentHash,
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
 * The caller (frontend) is responsible for submitting the transaction.
 */
export async function attestOnchain(
  subject: string,
  contentId: number,
  score: number,
  tokenUri: string,
  contentHash: string,
  chain: ChainConfig
): Promise<OnchainAttestation> {
  try {
    const { signature, nonce, expiry } = await signMintAuthorization(subject, contentId, score, tokenUri);
    return {
      type: "onchain",
      signature,
      nonce,
      expiry,
      contentId,
      score: Math.round(score),
      oracle: getOracleAddress(),
      controllerAddress: chain.controllerAddress,
      sbtAddress: chain.sbtAddress,
      tokenUri,
      contentHash,
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
 * Requires tokenUri (base64 data URI) and contentHash before calling.
 */
export async function buildAttestation(
  attest: "onchain" | "offchain" | "none",
  subject: string,
  contentId: number,
  score: number,
  tokenUri: string,
  contentHash: string,
  chain?: ChainConfig
): Promise<AttestationResult | undefined> {
  switch (attest) {
    case "none":
      return undefined;
    case "offchain":
      return attestOffchain(subject, contentId, score, tokenUri, contentHash);
    case "onchain":
      if (!chain) {
        throw new PoCWError("INVALID_CONFIG", "chain config required for on-chain attestation");
      }
      return attestOnchain(subject, contentId, score, tokenUri, contentHash, chain);
  }
}
