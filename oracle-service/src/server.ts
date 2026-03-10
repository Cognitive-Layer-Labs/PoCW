import app from "./app";
import * as dotenv from "dotenv";

dotenv.config();

const PORT = Number(process.env.PORT || 3000);

app.listen(PORT, () => {
  console.log(`Oracle service running on port ${PORT}`);
});

