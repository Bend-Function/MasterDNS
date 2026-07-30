import { migrate } from "drizzle-orm/postgres-js/migrator";
import { bootstrapAdmin } from "./bootstrap.js";
import { createDatabase } from "./index.js";

const database = createDatabase();
try {
  await migrate(database.db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
  await bootstrapAdmin(database.db);
  console.info("Database migration and bootstrap completed");
} finally {
  await database.close();
}
