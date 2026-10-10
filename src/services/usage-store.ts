/**
 * LLM / decisions call log (SQLite, same database as the content index).
 *
 * Every OpenRouter call — chat completions and decisions (Jev) — is recorded with the model
 * actually used, tokens, cost (usage.cost), latency and the resource / test session it belongs to
 * (from usage-context). GET /api/usage aggregates it. Rows older than USAGE_RETENTION_DAYS are
 * pruned when the store is attached (engine startup).
 *
 * The store is attached by the content store (initContentStore / __setDbForTest); while nothing is
 * attached, recording is a no-op. Recording never throws — the call log must not break a request.
 */

import type Database from "better-sqlite3";
import { currentUsageContext } from "./usage-context";

export const USAGE_RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;

let db: Database.Database | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS llm_calls (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT    NOT NULL,
  task            TEXT    NOT NULL,
  model           TEXT,
  requested_model TEXT,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cost_usd        REAL,
  latency_ms      INTEGER,
  ok              INTEGER NOT NULL,
  error           TEXT,
  outcome         TEXT,
  knowledge_id    TEXT,
  session_id      TEXT
);
CREATE TABLE IF NOT EXISTS finished_sessions (
  session_id   TEXT PRIMARY KEY,
  knowledge_id TEXT,
  finished_at  TEXT NOT NULL
);
`;

/** Indexes are created after the column migration (they may reference added columns). */
const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_llm_calls_ts ON llm_calls(ts);
CREATE INDEX IF NOT EXISTS idx_llm_calls_session ON llm_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_llm_calls_knowledge ON llm_calls(knowledge_id);
CREATE INDEX IF NOT EXISTS idx_finished_sessions_at ON finished_sessions(finished_at);
`;

/** Columns that later versions may add to llm_calls (added when missing). */
const LLM_CALL_COLUMNS: Array<[string, string]> = [
  ["requested_model", "TEXT"],
  ["outcome", "TEXT"],
  ["knowledge_id", "TEXT"],
  ["session_id", "TEXT"],
];

/** Create the tables (idempotent) and add missing columns. */
export function migrateUsageTables(database: Database.Database): void {
  database.exec(SCHEMA);
  const existing = new Set(
    (database.prepare("PRAGMA table_info(llm_calls)").all() as Array<{ name: string }>).map(c => c.name),
  );
  for (const [name, type] of LLM_CALL_COLUMNS) {
    if (!existing.has(name)) database.exec(`ALTER TABLE llm_calls ADD COLUMN ${name} ${type}`);
  }
  database.exec(INDEXES);
}

/** Attach (migrate + prune) or detach (null) the database used for the call log. */
export function attachUsageStore(database: Database.Database | null, now: Date = new Date()): void {
  db = database;
  if (!database) return;
  try {
    migrateUsageTables(database);
    pruneUsage(now);
  } catch (err) {
    console.warn("[usage-store] migration/prune failed — call logging disabled:", err instanceof Error ? err.message : err);
    db = null;
  }
}

/** Delete rows older than `days` days. Returns the number of call rows removed. */
export function pruneUsage(now: Date = new Date(), days = USAGE_RETENTION_DAYS): number {
  if (!db) return 0;
  const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
  const removed = db.prepare("DELETE FROM llm_calls WHERE ts < ?").run(cutoff).changes;
  db.prepare("DELETE FROM finished_sessions WHERE finished_at < ?").run(cutoff);
  return removed;
}

export interface CallRecord {
  /** kg | question | question_check | grade | grade_escalation | title | ... */
  task: string;
  /** Model that actually answered (from the response); falls back to requestedModel. */
  model?: string | null;
  /** Primary model that was requested. */
  requestedModel?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  latencyMs: number;
  ok: boolean;
  error?: string | null;
  outcome?: string | null;
  /** Default: the current usage context. */
  knowledgeId?: string | null;
  sessionId?: string | null;
  ts?: Date;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Record one call. Returns the row id (null when no store is attached or the insert failed). */
export function recordCall(rec: CallRecord): number | null {
  if (!db) return null;
  try {
    const ctx = currentUsageContext();
    const result = db.prepare(`
      INSERT INTO llm_calls (ts, task, model, requested_model, input_tokens, output_tokens, cost_usd,
                             latency_ms, ok, error, outcome, knowledge_id, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      (rec.ts ?? new Date()).toISOString(),
      rec.task,
      rec.model ?? rec.requestedModel ?? null,
      rec.requestedModel ?? null,
      num(rec.inputTokens),
      num(rec.outputTokens),
      num(rec.costUsd),
      Math.max(0, Math.round(rec.latencyMs)),
      rec.ok ? 1 : 0,
      rec.error ? String(rec.error).slice(0, 300) : null,
      rec.outcome ?? null,
      rec.knowledgeId !== undefined ? rec.knowledgeId : ctx.knowledgeId ?? null,
      rec.sessionId !== undefined ? rec.sessionId : ctx.sessionId ?? null,
    );
    return Number(result.lastInsertRowid);
  } catch (err) {
    console.warn("[usage-store] could not record call:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Attach an outcome (e.g. "pass", "regenerate:not_plain", "accepted") to a recorded call. */
export function setCallOutcome(id: number | null | undefined, outcome: string): void {
  if (!db || id == null) return;
  try {
    db.prepare("UPDATE llm_calls SET outcome = ? WHERE id = ?").run(outcome, id);
  } catch {
    // best effort
  }
}

/** Mark a test session as finished (its calls count towards perSession). Idempotent. */
export function recordSessionFinished(sessionId: string, knowledgeId: string | null, at: Date = new Date()): void {
  if (!db) return;
  try {
    db.prepare("INSERT OR IGNORE INTO finished_sessions (session_id, knowledge_id, finished_at) VALUES (?, ?, ?)")
      .run(sessionId, knowledgeId, at.toISOString());
  } catch {
    // best effort
  }
}

// ─── Aggregation (GET /api/usage) ────────────────────────────────────────────

export interface UsageSummary {
  totals: { calls: number; costUsd: number; errors: number };
  byDay: Array<{ date: string; calls: number; costUsd: number }>;
  byTask: Array<{ task: string; model: string; calls: number; costUsd: number; avgLatencyMs: number; errors: number }>;
  perBook: { avgCostUsd: number | null; count: number };
  perSession: { avgCostUsd: number | null; count: number };
  /** Outcome counts of the System One steps (extra, beyond the documented contract). */
  quality: {
    questionCheck: { checked: number; passed: number; regenerated: number; reasons: Record<string, number> };
    grading: { jev: number; escalated: number; reasons: Record<string, number> };
  };
}

/** Round a USD amount (costs are ~1e-5 per call) without float noise. */
const usd = (v: unknown): number => Math.round((Number(v) || 0) * 1e9) / 1e9;

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** Start (UTC midnight) of the window covering the last `days` calendar days including today. */
export function usageWindowStart(days: number, now: Date = new Date()): Date {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(today - (days - 1) * DAY_MS);
}

function emptySummary(days: number, now: Date): UsageSummary {
  const start = usageWindowStart(days, now).getTime();
  return {
    totals: { calls: 0, costUsd: 0, errors: 0 },
    byDay: Array.from({ length: days }, (_, i) => ({ date: isoDate(new Date(start + i * DAY_MS)), calls: 0, costUsd: 0 })),
    byTask: [],
    perBook: { avgCostUsd: null, count: 0 },
    perSession: { avgCostUsd: null, count: 0 },
    quality: {
      questionCheck: { checked: 0, passed: 0, regenerated: 0, reasons: {} },
      grading: { jev: 0, escalated: 0, reasons: {} },
    },
  };
}

/** Aggregate the call log over the last `days` UTC calendar days (including today). */
export function getUsageSummary(days: number, now: Date = new Date()): UsageSummary {
  const summary = emptySummary(days, now);
  if (!db) return summary;
  const since = usageWindowStart(days, now).toISOString();

  const totals = db.prepare(`
    SELECT COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(ok = 0), 0) AS errors
    FROM llm_calls WHERE ts >= ?
  `).get(since) as { calls: number; cost: number; errors: number };
  summary.totals = { calls: totals.calls, costUsd: usd(totals.cost), errors: totals.errors };

  const days_ = db.prepare(`
    SELECT substr(ts, 1, 10) AS date, COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS cost
    FROM llm_calls WHERE ts >= ? GROUP BY date
  `).all(since) as Array<{ date: string; calls: number; cost: number }>;
  const byDate = new Map(days_.map(d => [d.date, d]));
  summary.byDay = summary.byDay.map(d => {
    const row = byDate.get(d.date);
    return row ? { date: d.date, calls: row.calls, costUsd: usd(row.cost) } : d;
  });

  summary.byTask = (db.prepare(`
    SELECT task, COALESCE(model, requested_model, '') AS model, COUNT(*) AS calls,
           COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(AVG(latency_ms), 0) AS latency,
           COALESCE(SUM(ok = 0), 0) AS errors
    FROM llm_calls WHERE ts >= ?
    GROUP BY task, COALESCE(model, requested_model, '')
    ORDER BY cost DESC, calls DESC, task ASC
  `).all(since) as Array<{ task: string; model: string; calls: number; cost: number; latency: number; errors: number }>)
    .map(r => ({ task: r.task, model: r.model, calls: r.calls, costUsd: usd(r.cost), avgLatencyMs: Math.round(r.latency), errors: r.errors }));

  // Indexing cost per resource: calls tied to a resource but not to a test session.
  const book = db.prepare(`
    SELECT AVG(c) AS avg, COUNT(*) AS n FROM (
      SELECT knowledge_id, SUM(COALESCE(cost_usd, 0)) AS c FROM llm_calls
      WHERE ts >= ? AND knowledge_id IS NOT NULL AND session_id IS NULL
      GROUP BY knowledge_id)
  `).get(since) as { avg: number | null; n: number };
  summary.perBook = { avgCostUsd: book.n > 0 ? usd(book.avg) : null, count: book.n };

  // Generation + grading cost per finished test session (all of the session's calls).
  const session = db.prepare(`
    SELECT AVG(c) AS avg, COUNT(*) AS n FROM (
      SELECT f.session_id, COALESCE(SUM(l.cost_usd), 0) AS c
      FROM finished_sessions f LEFT JOIN llm_calls l ON l.session_id = f.session_id
      WHERE f.finished_at >= ?
      GROUP BY f.session_id)
  `).get(since) as { avg: number | null; n: number };
  summary.perSession = { avgCostUsd: session.n > 0 ? usd(session.avg) : null, count: session.n };

  const outcomes = db.prepare(`
    SELECT task, outcome, COUNT(*) AS n FROM llm_calls
    WHERE ts >= ? AND outcome IS NOT NULL AND task IN ('question_check', 'grade', 'grade_escalation')
    GROUP BY task, outcome
  `).all(since) as Array<{ task: string; outcome: string; n: number }>;
  const qc = summary.quality.questionCheck;
  const gr = summary.quality.grading;
  for (const { task, outcome, n } of outcomes) {
    if (task === "question_check") {
      if (outcome === "pass") { qc.passed += n; qc.checked += n; }
      else if (outcome.startsWith("regenerate:")) {
        qc.regenerated += n; qc.checked += n;
        for (const r of outcome.slice("regenerate:".length).split("+").filter(Boolean)) qc.reasons[r] = (qc.reasons[r] ?? 0) + n;
      }
    } else if (task === "grade" && outcome.startsWith("accepted")) {
      gr.jev += n;
    } else if (task === "grade_escalation" && outcome.startsWith("escalated:")) {
      gr.escalated += n;
      const r = outcome.slice("escalated:".length) || "unknown";
      gr.reasons[r] = (gr.reasons[r] ?? 0) + n;
    }
  }
  return summary;
}

/** Test helper: the attached database (or null). */
export function __usageDbForTest(): Database.Database | null {
  return db;
}
