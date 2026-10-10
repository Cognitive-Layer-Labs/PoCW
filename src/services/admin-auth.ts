/**
 * Admin action authorization via EIP-712 signature.
 *
 * Destructive admin operations (delete, wipe, reindex) require the request to carry a signature
 * produced by the admin wallet over a typed `AdminAction(action, target, expiry, nonce)`. The
 * oracle recovers the signer and checks it equals ADMIN_ADDRESS. Unlike the cosmetic
 * X-Admin-Address header (spoofable — the admin address is public and the KaL proxy forwards it
 * with the API key), a signature cannot be forged.
 *
 * Replay protection: each nonce is single-use within its expiry window; used nonces are
 * remembered in-memory until they expire.
 */
import { ethers } from "ethers";
import { Request, Response, NextFunction } from "express";
import { chainId } from "./chain-config";

/** Read lazily (not cached at module load) so tests and runtime env overrides both work. */
function adminAddress(): string {
  return (process.env.ADMIN_ADDRESS ?? "").toLowerCase();
}

const ADMIN_ACTION_TYPES = {
  AdminAction: [
    { name: "action", type: "string" },
    { name: "target", type: "string" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

/** Max allowed window between now and a signature's expiry — bounds the replay surface. */
const MAX_EXPIRY_WINDOW_SEC = 3600;

export interface AdminAuthPayload {
  action: string;
  target: string;
  expiry: number;
  nonce: string;
  signature: string;
}

export interface VerifyResult {
  ok: boolean;
  error?: string;
}

// Single-use nonce store (in-memory). Maps nonce → expiry (unix seconds). Pruned lazily.
const usedNonces = new Map<string, number>();

function pruneExpiredNonces(now: number): void {
  for (const [nonce, exp] of usedNonces) {
    if (exp < now) usedNonces.delete(nonce);
  }
}

/**
 * Verify an admin action signature. `expectedAction` and `expectedTarget` bind the signature to
 * the specific operation + resource, so a "delete X" signature cannot be replayed as "wipe".
 * Returns { ok: true } and marks the nonce used on success.
 *
 * Dev mode: when ADMIN_ADDRESS is unset, authorization is open (mirrors the cosmetic
 * requireAdmin behaviour) so local development without a configured admin still works.
 */
export function verifyAdminAction(
  payload: AdminAuthPayload | undefined,
  expectedAction: string,
  expectedTarget: string
): VerifyResult {
  const admin = adminAddress();
  if (!admin) return { ok: true };

  if (!payload) return { ok: false, error: "Missing admin authorization" };
  const { action, target, expiry, nonce, signature } = payload;
  if (!action || !target || !expiry || !nonce || !signature) {
    return { ok: false, error: "Incomplete admin authorization" };
  }
  if (action !== expectedAction) return { ok: false, error: "Action mismatch" };
  if (target !== expectedTarget) return { ok: false, error: "Target mismatch" };

  const now = Math.floor(Date.now() / 1000);
  if (expiry < now) return { ok: false, error: "Authorization expired" };
  if (expiry > now + MAX_EXPIRY_WINDOW_SEC) return { ok: false, error: "Expiry too far in the future" };

  pruneExpiredNonces(now);
  if (usedNonces.has(nonce)) return { ok: false, error: "Authorization already used (replay)" };

  const cid = chainId();
  if (!cid) return { ok: false, error: "CHAIN_ID not configured for admin verification" };

  const domain = { name: "PoCW-Admin", version: "1", chainId: cid };
  let recovered: string;
  try {
    recovered = ethers.verifyTypedData(
      domain,
      ADMIN_ACTION_TYPES,
      { action, target, expiry: BigInt(expiry), nonce },
      signature
    );
  } catch {
    return { ok: false, error: "Invalid signature" };
  }
  if (recovered.toLowerCase() !== admin) {
    return { ok: false, error: "Signer is not the admin wallet" };
  }

  usedNonces.set(nonce, expiry);
  return { ok: true };
}

/**
 * Express middleware factory. Reads the admin auth payload from `req.body._admin` and verifies it
 * against `expectedAction` and a per-request target (e.g. the knowledgeId route param, or "*" for
 * wipe). Sent in the body (not headers) so the KaL oracle proxy forwards it untouched.
 */
export function requireAdminAction(
  expectedAction: string,
  getTarget: (req: Request) => string
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const payload = (req.body ?? {})._admin as AdminAuthPayload | undefined;
    const result = verifyAdminAction(payload, expectedAction, getTarget(req));
    if (!result.ok) {
      res.status(403).json({ error: result.error ?? "Forbidden", code: "INVALID_CONFIG" });
      return;
    }
    next();
  };
}

/** Test helper: clear the used-nonce store between tests. */
export function __clearNonces(): void {
  usedNonces.clear();
}
