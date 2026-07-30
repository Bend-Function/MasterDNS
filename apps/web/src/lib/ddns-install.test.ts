import { describe, expect, it } from "vitest";
import { createPreviewDdnsInstall } from "./ddns-install";

describe("createPreviewDdnsInstall", () => {
  it("keeps the one-time token out of the process command", () => {
    const payload = createPreviewDdnsInstall(Date.UTC(2026, 6, 30));

    expect(payload.command).not.toContain("--token");
    expect(payload.command).not.toContain(payload.installToken);
    expect(payload.expiresAt).toBe("2026-07-30T00:15:00.000Z");
  });
});
