import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { httpCheckConfigSchema, tcpCheckConfigSchema } from "@masterdns/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { HttpHealthChecker } from "./http-checker.js";
import { assertAllowedNetworkTarget } from "./network-policy.js";
import { TcpHealthChecker } from "./tcp-checker.js";

const openServers: Array<HttpServer | TcpServer> = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("HTTP health checker", () => {
  it("connects to the target IP while sending the configured Host header", async () => {
    const server = createHttpServer((request, response) => {
      if (request.headers.host === "service.internal" && request.url === "/ready") {
        response.writeHead(204).end();
      } else {
        response.writeHead(503).end();
      }
    });
    const port = await listen(server);
    const result = await new HttpHealthChecker({ allowPrivate: true, allowLoopback: true }).check({ address: "127.0.0.1", port, hostname: "service.internal" }, httpCheckConfigSchema.parse({
      type: "http",
      protocol: "http",
      method: "HEAD",
      path: "/ready",
      expectedStatuses: [204],
      timeoutMs: 1000,
    }));
    expect(result).toMatchObject({ success: true, statusCode: 204 });
  });

  it("reports a response body mismatch without throwing", async () => {
    const server = createHttpServer((_request, response) => response.writeHead(200).end("starting"));
    const port = await listen(server);
    const result = await new HttpHealthChecker({ allowPrivate: true, allowLoopback: true }).check({ address: "127.0.0.1", port }, httpCheckConfigSchema.parse({
      type: "http",
      protocol: "http",
      path: "/",
      bodyContains: "ready",
      timeoutMs: 1000,
    }));
    expect(result).toMatchObject({ success: false, statusCode: 200, errorCode: "body_mismatch" });
  });
});

describe("TCP health checker", () => {
  it("reports a successful TCP connect", async () => {
    const server = createTcpServer((socket) => socket.end());
    const port = await listen(server);
    const result = await new TcpHealthChecker({ allowPrivate: true, allowLoopback: true }).check({ address: "127.0.0.1", port, family: 4 }, tcpCheckConfigSchema.parse({ type: "tcp", port, timeoutMs: 1000 }));
    expect(result.success).toBe(true);
  });

  it("classifies a refused TCP connection as a failed result", async () => {
    const server = createTcpServer();
    const port = await listen(server);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    openServers.splice(openServers.indexOf(server), 1);
    const result = await new TcpHealthChecker({ allowPrivate: true, allowLoopback: true }).check({ address: "127.0.0.1", port, family: 4 }, tcpCheckConfigSchema.parse({ type: "tcp", port, timeoutMs: 1000 }));
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("econnrefused");
  });
});

describe("checker security boundaries", () => {
  it("rejects invalid response patterns during configuration validation", () => {
    expect(() => httpCheckConfigSchema.parse({
      type: "http",
      protocol: "http",
      path: "/",
      bodyPattern: "(",
    })).toThrow(/正则表达式/);
  });

  it("blocks loopback and link-local targets even when private targets are enabled", async () => {
    const config = tcpCheckConfigSchema.parse({ type: "tcp", port: 80, timeoutMs: 100 });
    const checker = new TcpHealthChecker({ allowPrivate: true });
    await expect(checker.check({ address: "127.0.0.1", port: 80, family: 4 }, config))
      .resolves.toMatchObject({ success: false, errorCode: "target_not_allowed" });
    await expect(checker.check({ address: "169.254.169.254", port: 80, family: 4 }, config))
      .resolves.toMatchObject({ success: false, errorCode: "target_not_allowed" });
    await expect(checker.check({ address: "::1", port: 80, family: 6 }, config))
      .resolves.toMatchObject({ success: false, errorCode: "target_not_allowed" });
    await expect(checker.check({ address: "fe80::1", port: 80, family: 6 }, config))
      .resolves.toMatchObject({ success: false, errorCode: "target_not_allowed" });
    await expect(checker.check({ address: "2001:db8::1", port: 80, family: 6 }, config))
      .resolves.toMatchObject({ success: false, errorCode: "target_not_allowed" });
  });

  it("requires explicit opt-in for private network targets", async () => {
    const config = tcpCheckConfigSchema.parse({ type: "tcp", port: 80, timeoutMs: 100 });
    await expect(new TcpHealthChecker().check({ address: "10.0.0.1", port: 80, family: 4 }, config))
      .resolves.toMatchObject({ success: false, errorCode: "target_not_allowed" });
    await expect(new TcpHealthChecker().check({ address: "fd00::1", port: 80, family: 6 }, config))
      .resolves.toMatchObject({ success: false, errorCode: "target_not_allowed" });
  });

  it("does not over-block public addresses adjacent to special-purpose IPv4 ranges", () => {
    expect(() => assertAllowedNetworkTarget("192.0.1.1")).not.toThrow();
  });

  it("terminates catastrophic response patterns outside the main event loop", async () => {
    const server = createHttpServer((_request, response) => response.writeHead(200).end(`${"a".repeat(100_000)}!`));
    const port = await listen(server);
    const result = await new HttpHealthChecker({ allowPrivate: true, allowLoopback: true }).check({ address: "127.0.0.1", port }, httpCheckConfigSchema.parse({
      type: "http",
      protocol: "http",
      path: "/",
      bodyPattern: "^(a+)+$",
      timeoutMs: 1000,
    }));
    expect(result).toMatchObject({ success: false, errorCode: "pattern_timeout" });
  });
});

async function listen(server: HttpServer | TcpServer): Promise<number> {
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
  return address.port;
}
