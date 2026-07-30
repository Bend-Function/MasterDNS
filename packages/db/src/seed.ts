import { bootstrapAdmin } from "./bootstrap.js";
import { createDatabase } from "./index.js";

const database = createDatabase();
try {
  const created = await bootstrapAdmin(database.db);
  console.info(created ? "Bootstrap administrator created" : "Database already contains users; seed skipped");
} finally {
  await database.close();
}
