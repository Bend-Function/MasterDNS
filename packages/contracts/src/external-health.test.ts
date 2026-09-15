import { expect, it } from "vitest";
import { externalHealthCheckConfigSchema } from "./external-health.js";
import { healthCheckConfigSchema } from "./health.js";
it("rejects JS lookaround and backreferences only for external execution", () => {
  for (const bodyPattern of ["a(?=b)", "(?<!a)b", "(a)\\1", "(?<word>a)\\k<word>", "a{1001}", "[^]", "[]", "[\\b]", "[\\d-a]"]) {
    const config = { type: "http", bodyPattern };
    expect(healthCheckConfigSchema.safeParse(config).success).toBe(true);
    expect(externalHealthCheckConfigSchema.safeParse(config).success).toBe(false);
  }
});
it("accepts useful shared groups, character classes and bounded repetition", () => {
  for (const bodyPattern of ["^status: (ok|ready)$", "[a-zA-Z0-9_-]{1,64}", "version [0-9]+\\.[0-9]+", "\\d{2,4}-[a-z]+", "(?:ok|ready)"]) {
    expect(externalHealthCheckConfigSchema.safeParse({ type: "http", bodyPattern }).success).toBe(true);
  }
});
