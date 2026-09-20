import type { HttpCheckConfig } from "@masterdns/contracts";

export function buildHttpHealthConfig(config: Omit<HttpCheckConfig, "expectedStatuses">, statusList: string): HttpCheckConfig {
  const tokens = statusList.split(",").map((item) => item.trim()).filter(Boolean);
  if (tokens.some((item) => !/^[1-5]\d{2}$/u.test(item))) throw new Error("期望状态码列表需填写 100–599 的三位状态码，以逗号分隔");
  const expectedStatuses = tokens.map(Number);
  return { ...config, ...(expectedStatuses.length ? { expectedStatuses } : {}) };
}
