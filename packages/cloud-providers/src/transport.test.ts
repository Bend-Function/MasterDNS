import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { Ec2CloudAdapter } from "./ec2.js";

describe("AWS transport deadline", () => {
  it("aborts a stalled identity request without retrying it", async () => {
    let requests = 0;
    const server = createServer(() => { requests++; });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    vi.stubEnv("AWS_ENDPOINT_URL_STS", `http://127.0.0.1:${address.port}`);
    try {
      const adapter = new Ec2CloudAdapter("test", { kind: "access_key", accessKeyId: "test", secretAccessKey: "test" });
      const result = await Promise.race([
        adapter.verifyIdentity().catch((error: unknown) => error),
        new Promise((resolve) => { const timer = setTimeout(() => resolve("request still pending"), 12000); timer.unref(); }),
      ]);
      expect(result).toMatchObject({ code: "temporary_cloud_error" });
      expect(requests).toBe(1);
    } finally {
      vi.unstubAllEnvs();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);
});
