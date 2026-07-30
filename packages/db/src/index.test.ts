import { describe, expect, it } from "vitest";
import { resolveDatabaseConnection } from "./index.js";

describe("database connection environment", () => {
  it("keeps DATABASE_URL compatibility", () => {
    expect(resolveDatabaseConnection({ DATABASE_URL: "postgres://user:pass@localhost/database" })).toEqual({
      kind: "url",
      url: "postgres://user:pass@localhost/database",
    });
  });

  it("passes arbitrary passwords as connection parameters", () => {
    expect(resolveDatabaseConnection({
      PGHOST: "postgres",
      PGPORT: "5432",
      PGDATABASE: "masterdns",
      PGUSER: "masterdns",
      PGPASSWORD: "p/ss?#:@ word",
    })).toEqual({
      kind: "parameters",
      host: "postgres",
      port: 5432,
      database: "masterdns",
      user: "masterdns",
      password: "p/ss?#:@ word",
    });
  });

  it("rejects incomplete parameter configuration", () => {
    expect(() => resolveDatabaseConnection({ PGHOST: "postgres" })).toThrow("PGDATABASE");
  });

  it("rejects invalid ports", () => {
    expect(() => resolveDatabaseConnection({ PGPORT: "not-a-port" })).toThrow("PGPORT");
  });
});
