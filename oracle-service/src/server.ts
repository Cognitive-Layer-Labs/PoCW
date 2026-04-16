import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env") });

import app, { setPoCWInstance, initAppServices } from "./app";
import { PoCW } from "./sdk/index";

const PORT = Number(process.env.PORT || 3000);
const PRIMARY_DB_PATH = process.env.POCW_DB_PATH || path.resolve(process.cwd(), "data", "pocw.db");
const FALLBACK_DB_PATH = path.resolve(process.cwd(), "tmp", "pocw.db");

function isSqliteCantOpen(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "SQLITE_CANTOPEN";
}

async function start() {
  let pocw = new PoCW({ dbPath: PRIMARY_DB_PATH });
  try {
    await pocw.init();
  } catch (err) {
    if (!isSqliteCantOpen(err) || PRIMARY_DB_PATH === FALLBACK_DB_PATH) {
      throw err;
    }

    console.warn(
      `[oracle] Primary SQLite path failed (${PRIMARY_DB_PATH}). ` +
      `Falling back to ${FALLBACK_DB_PATH}.`
    );

    pocw = new PoCW({ dbPath: FALLBACK_DB_PATH });
    await pocw.init();
  }

  setPoCWInstance(pocw);

  await initAppServices();

  app.listen(PORT, () => {
    console.log(`Oracle service running on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
