import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export * from "./schema/index.js";

export type MasterDnsDatabase = ReturnType<typeof createDatabase>["db"];

export type DatabaseConnection =
  | { kind: "url"; url: string }
  | { kind: "parameters"; host: string; port: number; database: string; user: string; password: string };

export function createDatabase(databaseUrl?: string) {
  const connection = databaseUrl === undefined
    ? resolveDatabaseConnection(process.env)
    : { kind: "url" as const, url: requiredValue("DATABASE_URL", databaseUrl) };
  const client = connection.kind === "url"
    ? postgres(connection.url, { max: 10, prepare: false })
    : postgres({
      host: connection.host,
      port: connection.port,
      database: connection.database,
      user: connection.user,
      password: connection.password,
      max: 10,
      prepare: false,
    });
  const db = drizzle(client, { schema });
  return { db, client, close: () => client.end() };
}

export function resolveDatabaseConnection(environment: NodeJS.ProcessEnv): DatabaseConnection {
  if (environment.DATABASE_URL) return { kind: "url", url: environment.DATABASE_URL };

  const portValue = environment.PGPORT ?? "5432";
  if (!/^\d+$/.test(portValue)) throw new Error("PGPORT must be an integer between 1 and 65535");
  const port = Number(portValue);
  if (port < 1 || port > 65_535) throw new Error("PGPORT must be an integer between 1 and 65535");

  return {
    kind: "parameters",
    host: requiredValue("PGHOST", environment.PGHOST),
    port,
    database: requiredValue("PGDATABASE", environment.PGDATABASE),
    user: requiredValue("PGUSER", environment.PGUSER),
    password: requiredValue("PGPASSWORD", environment.PGPASSWORD),
  };
}

function requiredValue(name: string, value: string | undefined): string {
  if (!value) throw new Error(`DATABASE_URL or ${name} is required`);
  return value;
}
