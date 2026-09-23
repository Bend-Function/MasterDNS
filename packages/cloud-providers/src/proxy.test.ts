import { connect, createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createCloudFetch, parseCloudProxyUrl, proxyEndpoint } from "./proxy.js";

const sockets = new Set<Socket>();
let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await closeServer?.();
  closeServer = undefined;
});

describe("cloud SOCKS proxy URL", () => {
  it.each([
    "http://proxy.example:1080",
    "socks4://proxy.example:1080",
    "socks5h://:secret@proxy.example:1080",
    "socks5h://proxy.example:0",
    "socks5h://proxy.example:65536",
    "socks5h:///missing-host",
    "socks5h://proxy.example:1080/path",
    "socks5h://proxy.example:1080/?query=1",
    "socks5h://proxy.example:1080/#fragment",
  ])("rejects unsafe proxy URL %s", value => {
    expect(() => parseCloudProxyUrl(value)).toThrow("Invalid SOCKS proxy URL");
  });

  it("accepts SOCKS5 URLs and returns a credential-free endpoint", () => {
    expect(parseCloudProxyUrl("socks5h://user:p%40ss@[2001:db8::1]:1080")).toMatchObject({
      href: "socks5h://user:p%40ss@[2001:db8::1]:1080",
      hostname: "[2001:db8::1]",
      port: 1080,
    });
    expect(proxyEndpoint("socks5h://user:p%40ss@[2001:db8::1]:1080")).toBe("socks5h://[2001:db8::1]:1080");
    expect(proxyEndpoint("socks5://proxy.example")).toBe("socks5://proxy.example:1080");
  });
});

describe("cloud fetch through SOCKS", () => {
  it("uses authenticated SOCKS5 remote DNS without exposing credentials to the destination", async () => {
    const observed: { username?: string; password?: string; host?: string; request?: string } = {};
    const target = createServer(socket => {
      sockets.add(socket);
      socket.once("data", data => {
        observed.request = data.toString("utf8");
        socket.end("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 11\r\nconnection: close\r\n\r\n{\"ok\":true}");
      });
    });
    await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve));
    const targetPort = (target.address() as { port: number }).port;

    const proxy = createServer(socket => {
      sockets.add(socket);
      let buffer = Buffer.alloc(0);
      let stage: "greeting" | "auth" | "connect" | "tunnel" = "greeting";
      socket.on("data", chunk => {
        if (stage === "tunnel") return;
        buffer = Buffer.concat([buffer, chunk]);
        if (stage === "greeting" && buffer.length >= 4) {
          buffer = buffer.subarray(4); stage = "auth"; socket.write(Buffer.from([5, 2]));
        }
        if (stage === "auth" && buffer.length >= 3) {
          const usernameLength = buffer[1]!;
          if (buffer.length < 3 + usernameLength) return;
          const passwordLength = buffer[2 + usernameLength]!;
          if (buffer.length < 3 + usernameLength + passwordLength) return;
          observed.username = buffer.subarray(2, 2 + usernameLength).toString();
          observed.password = buffer.subarray(3 + usernameLength, 3 + usernameLength + passwordLength).toString();
          buffer = buffer.subarray(3 + usernameLength + passwordLength); stage = "connect"; socket.write(Buffer.from([1, 0]));
        }
        if (stage === "connect" && buffer.length >= 7) {
          expect(buffer[3]).toBe(3);
          const hostLength = buffer[4]!;
          if (buffer.length < 7 + hostLength) return;
          observed.host = buffer.subarray(5, 5 + hostLength).toString();
          const upstream = connect(targetPort, "127.0.0.1", () => {
            socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, targetPort >> 8, targetPort & 255]));
            stage = "tunnel";
            const remainder = buffer.subarray(7 + hostLength);
            socket.pipe(upstream).pipe(socket);
            if (remainder.length) upstream.write(remainder);
          }); sockets.add(upstream);
        }
      });
    });
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    const proxyPort = (proxy.address() as { port: number }).port;
    closeServer = async () => {
      await Promise.all([new Promise<void>(resolve => target.close(() => resolve())), new Promise<void>(resolve => proxy.close(() => resolve()))]);
    };

    const response = await createCloudFetch(`socks5h://alice:secret@127.0.0.1:${proxyPort}`)("http://fixed-cloud.invalid/resource", {
      headers: { authorization: "Bearer cloud-secret" },
    });
    expect(await response.json()).toEqual({ ok: true });
    expect(observed).toMatchObject({ username: "alice", password: "secret", host: "fixed-cloud.invalid" });
    expect(observed.request).toContain("authorization: Bearer cloud-secret");
    expect(observed.request).not.toContain("alice");
    expect(observed.request).not.toContain("secret@127.0.0.1");
  });

  it("propagates abort signals while connecting through SOCKS", async () => {
    const proxy = createServer(socket => sockets.add(socket));
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    const proxyPort = (proxy.address() as { port: number }).port;
    closeServer = () => new Promise<void>(resolve => proxy.close(() => resolve()));
    const controller = new AbortController();
    const pending = createCloudFetch(`socks5h://127.0.0.1:${proxyPort}`)("https://fixed-cloud.invalid", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("connects to an IPv6 SOCKS proxy without treating URL brackets as DNS", async () => {
    const target = createServer(socket => {
      sockets.add(socket);
      socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok"));
    });
    await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve));
    const targetPort = (target.address() as { port: number }).port;
    const proxy = createServer(socket => {
      sockets.add(socket);
      let buffer = Buffer.alloc(0);
      let stage: "greeting" | "connect" | "tunnel" = "greeting";
      socket.on("data", chunk => {
        if (stage === "tunnel") return;
        buffer = Buffer.concat([buffer, chunk]);
        if (stage === "greeting" && buffer.length >= 2 + buffer[1]!) {
          buffer = buffer.subarray(2 + buffer[1]!);
          stage = "connect";
          socket.write(Buffer.from([5, 0]));
        }
        if (stage !== "connect" || buffer.length < 7 || buffer[0] !== 5 || buffer[3] !== 3) return;
        const hostLength = buffer[4]!;
        if (buffer.length < 7 + hostLength) return;
        const upstream = connect(targetPort, "127.0.0.1", () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, targetPort >> 8, targetPort & 255]));
          stage = "tunnel";
          const remainder = buffer.subarray(7 + hostLength);
          socket.pipe(upstream).pipe(socket);
          if (remainder.length) upstream.write(remainder);
        });
        sockets.add(upstream);
      });
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "::1", () => { proxy.off("error", reject); resolve(); });
    });
    const proxyPort = (proxy.address() as { port: number }).port;
    closeServer = async () => {
      await Promise.all([new Promise<void>(resolve => target.close(() => resolve())), new Promise<void>(resolve => proxy.close(() => resolve()))]);
    };

    const response = await createCloudFetch(`socks5h://[::1]:${proxyPort}`)("http://fixed-cloud.invalid/resource");
    expect(await response.text()).toBe("ok");
  });
});
