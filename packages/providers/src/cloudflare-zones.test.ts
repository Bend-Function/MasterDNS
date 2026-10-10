import Cloudflare from "cloudflare";
import { describe, expect, it, vi } from "vitest";
import { CloudflareDnsAdapter } from "./cloudflare.js";

const remote = { id: "zone-1", name: "example.com", status: "pending", type: "full", account: { id: "a".repeat(32), name: "Production" }, name_servers: ["amy.ns.cloudflare.com", "bob.ns.cloudflare.com"] };
const input = { name: "example.com", accountId: "a".repeat(32) };

describe("Cloudflare zone onboarding", () => {
  it("creates a full zone in the explicit account and preserves activation information", async () => {
    const create = vi.fn().mockResolvedValue(remote);
    const adapter = new CloudflareDnsAdapter("test-token", { zones: { create } } as never);
    expect(await adapter.createZone(input)).toEqual({
      externalId: "zone-1", name: "example.com", status: "pending",
      providerMetadata: { accountId: "a".repeat(32), accountName: "Production", type: "full", nameServers: ["amy.ns.cloudflare.com", "bob.ns.cloudflare.com"], zoneStatus: "pending" },
    });
    expect(create).toHaveBeenCalledWith({ account: { id: "a".repeat(32) }, name: "example.com", type: "full" }, { maxRetries: 0 });
  });

  it("looks up an existing zone within the requested account", async () => {
    const list = vi.fn().mockResolvedValue({ result: [remote] });
    const adapter = new CloudflareDnsAdapter("test-token", { zones: { list } } as never);
    expect(await adapter.findZone(input)).toMatchObject({ externalId: "zone-1", status: "pending" });
    expect(list).toHaveBeenCalledWith({ account: { id: "a".repeat(32) }, name: "example.com", page: 1, per_page: 5 });
    list.mockResolvedValue({ result: [] });
    expect(await adapter.findZone(input)).toBeNull();
  });

  it("keeps the remote activation state when listing zones", async () => {
    const adapter = new CloudflareDnsAdapter("test-token", { zones: { list: vi.fn().mockResolvedValue({ result: [remote], hasNextPage: () => false }) } } as never);
    expect((await adapter.listZones()).items[0]).toMatchObject({ status: "pending", providerMetadata: { zoneStatus: "pending", nameServers: remote.name_servers } });
  });

  it("redacts permission errors from zone creation", async () => {
    const error = new Cloudflare.PermissionDeniedError(403, { message: "secret-token" }, "secret-token", new Headers());
    const adapter = new CloudflareDnsAdapter("test-token", { zones: { create: vi.fn().mockRejectedValue(error) } } as never);
    await expect(adapter.createZone(input)).rejects.toMatchObject({ code: "permission_denied", message: "Cloudflare permission denied" });
  });

  it("verifies credentials and paginates inventory within Cloudflare's zone page limits", async () => {
    const list = vi.fn(async ({ per_page }: { per_page: number }) => {
      if (per_page < 5 || per_page > 50) throw new Cloudflare.BadRequestError(400, {}, "invalid per_page", new Headers());
      return { result: [remote], hasNextPage: () => true };
    });
    const adapter = new CloudflareDnsAdapter("test-token", { user: { tokens: { verify: async () => ({ status: "active" }) } }, zones: { list } } as never);
    expect(await adapter.verifyCredentials()).toMatchObject({ canReadZones: true });
    expect(await adapter.listZones("2")).toMatchObject({ nextCursor: "3", items: [{ externalId: "zone-1" }] });
    expect(list).toHaveBeenLastCalledWith({ page: 2, per_page: 50, order: "name", direction: "asc" });
  });
});
