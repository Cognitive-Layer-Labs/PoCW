/**
 * Redis-backed session store.
 *
 * Replaces the in-process Map so sessions survive oracle restarts.
 * TTL = 30 min (matches SESSION_TTL_MS in app.ts).
 */

import Redis from "ioredis";
import { VerifySession, SessionSnapshot } from "../sdk/verify-session";

let redis: Redis | null = null;
const SESSION_TTL = 30 * 60; // 30 minutes

export async function initSessionStore(url = process.env.REDIS_URL ?? "redis://localhost:6379/1"): Promise<void> {
  if (redis) return;
  redis = new Redis(url, {
    retryStrategy: (times: number) => {
      if (times > 3) return null;
      return Math.min(times * 200, 2000);
    },
    maxRetriesPerRequest: 3,
  });
  redis.on("error", (err: Error) => console.error("[session-store] Redis error:", err.message));
  await redis.ping();
}

export async function saveSession(session: VerifySession): Promise<void> {
  if (!redis) throw new Error("Session store not initialized");
  const snap = session.toSnapshot();
  await redis.set(`pocw:session:${snap.sessionId}`, JSON.stringify(snap), "EX", SESSION_TTL);
}

export async function loadSession(sessionId: string): Promise<VerifySession | undefined> {
  if (!redis) throw new Error("Session store not initialized");
  const raw = await redis.get(`pocw:session:${sessionId}`);
  if (!raw) return undefined;
  const snap: SessionSnapshot = JSON.parse(raw);
  return VerifySession.fromSnapshot(snap);
}

export async function deleteSession(sessionId: string): Promise<void> {
  if (!redis) throw new Error("Session store not initialized");
  await redis.del(`pocw:session:${sessionId}`);
}

export async function touchSession(sessionId: string): Promise<void> {
  if (!redis) throw new Error("Session store not initialized");
  await redis.expire(`pocw:session:${sessionId}`, SESSION_TTL);
}
