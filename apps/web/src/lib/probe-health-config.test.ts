import { healthCheckConfigSchema, type HttpCheckConfig } from "@masterdns/contracts";
import { describe, expect, it } from "vitest";
import { buildHttpHealthConfig } from "./probe-health-config";

const request: Omit<HttpCheckConfig, "expectedStatuses"> = {
  type: "http", protocol: "https", method: "GET", path: "/health", headers: {},
  expectedStatusMin: 201, expectedStatusMax: 299, followRedirects: true, verifyTls: true, timeoutMs: 3000,
};

describe("probe HTTP health config", () => {
  it.each(["", " \t\n ", " , , \t"])("uses the configured range when the status list has no codes: %j", (statusList) => {
    const config = buildHttpHealthConfig(request, statusList);
    expect(healthCheckConfigSchema.safeParse(config).success).toBe(true);
    expect(config).not.toHaveProperty("expectedStatuses");
    expect(config).toMatchObject({ expectedStatusMin: 201, expectedStatusMax: 299 });
  });

  it.each(["200, 204, 503", " , 200, , 204, 503, "])("preserves explicit codes, including codes outside the range: %j", (statusList) => {
    const config = buildHttpHealthConfig(request, statusList);
    expect(healthCheckConfigSchema.parse(config)).toMatchObject({ expectedStatuses: [200, 204, 503] });
  });

  it.each(["nonsense", "200, nonsense", "200.5", "2e2", "0xc8", "99", "600"])("rejects invalid status tokens with an actionable error: %j", (statusList) => {
    expect(() => buildHttpHealthConfig(request, statusList)).toThrow(/状态码.*100.*599/);
  });
});
