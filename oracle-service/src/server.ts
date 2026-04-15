import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env") });

import app, { setPoCWInstance, initAppServices } from "./app";
import { PoCW } from "./sdk/index";

const PORT = Number(process.env.PORT || 3000);

async function start() {
  const pocw = new PoCW();
  await pocw.init();
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
