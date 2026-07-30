import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { postJsonToAllowedUrl } from "./outbound-request.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("outbound request policy", () => {
  it("pins an explicitly approved resolution and does not expose the response body", async () => {
    const server = createServer((request, response) => {
      expect(request.headers.host).toContain("localhost");
      response.writeHead(204).end();
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    await expect(postJsonToAllowedUrl(`http://localhost:${address.port}/hook`, {
      headers: { "content-type": "application/json" },
      body: "{}",
      timeoutMs: 1000,
      policy: { allowPrivate: true, allowLoopback: true },
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    })).resolves.toBe(204);
  });

  it("rejects loopback, link-local and private DNS answers by default", async () => {
    const base = {
      headers: { "content-type": "application/json" },
      body: "{}",
      timeoutMs: 1000,
    };
    for (const address of ["127.0.0.1", "169.254.169.254", "10.0.0.1"]) {
      await expect(postJsonToAllowedUrl("https://example.invalid/hook", {
        ...base,
        resolve: async () => [{ address, family: 4 }],
      })).rejects.toMatchObject({ code: "target_not_allowed" });
    }
  });
});
