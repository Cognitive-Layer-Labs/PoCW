import * as dotenv from "dotenv";
import * as path from "path";

// Load .env from the project root (dist/ or src/ → ..). Variables already set win.
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

import app, { setPoCWInstance, initAppServices } from "./app";
import { PoCW } from "./sdk/index";

const PORT = Number(process.env.PORT || 3000);
const PRIMARY_DB_PATH = process.env.POCW_DB_PATH || path.resolve(process.cwd(), "data", "pocw.db");
const FALLBACK_DB_PATH = path.resolve(process.cwd(), "tmp", "pocw.db");

function isSqliteCantOpen(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "SQLITE_CANTOPEN";
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message || err.name : String(err);
}

/** Log a single clear line and exit (no stack-trace spam on expected startup failures). */
function fatal(message: string): never {
  console.error(`[engine] FATAL: ${message}`);
  process.exit(1);
}

async function start(): Promise<void> {
  // In production, require an API key to protect all /api routes.
  if (process.env.NODE_ENV === "production" && !process.env.POCW_API_KEY) {
    fatal("POCW_API_KEY must be set in production. Refusing to start.");
  }
  if (!process.env.OPENROUTER_API_KEY) {
    console.warn("[engine] OPENROUTER_API_KEY is not set — indexing and question generation will fail.");
  }
  if (!process.env.ADMIN_API_KEY) {
    console.log("[engine] ADMIN_API_KEY not set — admin API disabled.");
  }

  let pocw = new PoCW({ dbPath: PRIMARY_DB_PATH });
  try {
    await pocw.init();
  } catch (err) {
    if (!isSqliteCantOpen(err) || PRIMARY_DB_PATH === FALLBACK_DB_PATH) {
      fatal(`could not open content store at ${PRIMARY_DB_PATH}: ${describe(err)}`);
    }
    console.warn(
      `[engine] Primary SQLite path failed (${PRIMARY_DB_PATH}). Falling back to ${FALLBACK_DB_PATH}.`
    );
    pocw = new PoCW({ dbPath: FALLBACK_DB_PATH });
    await pocw.init();
  }

  setPoCWInstance(pocw);

  try {
    await initAppServices();
  } catch (err) {
    const url = (process.env.REDIS_URL ?? "redis://localhost:6379/1").replace(/\/\/[^@/]*@/, "//***@");
    fatal(`cannot connect to Redis session store at ${url} (${describe(err)}). Is Redis running and REDIS_URL correct?`);
  }

  const server = app.listen(PORT, () => {
    console.log(`[engine] PoCW engine listening on port ${PORT}`);
  });
  server.on("error", (err) => fatal(`HTTP server error: ${describe(err)}`));

  const shutdown = (signal: string) => {
    console.log(`[engine] ${signal} received — shutting down`);
    server.close(() => {
      pocw.close().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((err) => fatal(`failed to start: ${describe(err)}`));
