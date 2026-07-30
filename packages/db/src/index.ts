import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export * from "./schema/index.js";

export type MasterDnsDatabase = ReturnType<typeof createDatabase>["db"];

export function createDatabase(databaseUrl = requiredDatabaseUrl()) {
  const client = postgres(databaseUrl, { max: 10, prepare: false });
  const db = drizzle(client, { schema });
  return { db, client, close: () => client.end() };
}

function requiredDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required");
  return value;
}
