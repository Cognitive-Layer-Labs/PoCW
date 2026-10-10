/**
 * Attestation store — persists the minimal data of a passing session so the learner can
 * re-mint (re-attest) later (e.g. after they get gas) and so the account page can list their
 * earned SBTs without scanning the chain.
 *
 * Shares the same SQLite file as the content store (data/pocw.db).
 */
import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";

let db: Database.Database | null = null;

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS attestations (
  subject        TEXT    NOT NULL,
  content_id     INTEGER NOT NULL,
  knowledge_id   TEXT,
  score          INTEGER NOT NULL,
  kal_amount_wei TEXT    NOT NULL,
  token_uri      TEXT    NOT NULL,
  content_hash   TEXT,
  updated_at     TEXT    NOT NULL,
  PRIMARY KEY (subject, content_id)
);`;

export function initAttestationStore(
  dbPath: string = path.resolve(process.cwd(), "data", "pocw.db")
): void {
  if (db) return;
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(CREATE_TABLE);
}

function getDb(): Database.Database {
  if (!db) initAttestationStore();
  return db!;
}

export interface StoredAttestation {
  subject: string;
  contentId: number;
  knowledgeId: string | null;
  score: number;
  kalAmountWei: string;
  tokenUri: string;
  contentHash: string | null;
}

export function saveAttestation(a: StoredAttestation): void {
  getDb().prepare(`
    INSERT INTO attestations (subject, content_id, knowledge_id, score, kal_amount_wei, token_uri, content_hash, updated_at)
    VALUES (@subject, @contentId, @knowledgeId, @score, @kalAmountWei, @tokenUri, @contentHash, @updatedAt)
    ON CONFLICT(subject, content_id) DO UPDATE SET
      knowledge_id   = excluded.knowledge_id,
      score          = excluded.score,
      kal_amount_wei = excluded.kal_amount_wei,
      token_uri      = excluded.token_uri,
      content_hash   = excluded.content_hash,
      updated_at     = excluded.updated_at
  `).run({ ...a, subject: a.subject.toLowerCase(), updatedAt: new Date().toISOString() });
}

function rowToObj(row: Record<string, unknown>): StoredAttestation {
  return {
    subject: row.subject as string,
    contentId: row.content_id as number,
    knowledgeId: (row.knowledge_id as string) ?? null,
    score: row.score as number,
    kalAmountWei: row.kal_amount_wei as string,
    tokenUri: row.token_uri as string,
    contentHash: (row.content_hash as string) ?? null,
  };
}

export function getAttestation(subject: string, contentId: number): StoredAttestation | null {
  const row = getDb()
    .prepare("SELECT * FROM attestations WHERE subject = ? AND content_id = ?")
    .get(subject.toLowerCase(), contentId) as Record<string, unknown> | undefined;
  return row ? rowToObj(row) : null;
}

export function listAttestationsBySubject(subject: string): StoredAttestation[] {
  const rows = getDb()
    .prepare("SELECT * FROM attestations WHERE subject = ? ORDER BY updated_at DESC")
    .all(subject.toLowerCase()) as Record<string, unknown>[];
  return rows.map(rowToObj);
}
