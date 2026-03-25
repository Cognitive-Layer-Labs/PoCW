import app from "./app";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env") });

const PORT = Number(process.env.PORT || 3000);

app.listen(PORT, () => {
  console.log(`Oracle service running on port ${PORT}`);
});

