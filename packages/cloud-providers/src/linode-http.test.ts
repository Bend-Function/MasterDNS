import { describe, expect, it } from "vitest";
import { LinodeHttp } from "./linode-http.js";

function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "X-Customer-UUID": "customer", "X-OAuth-Scopes": "*", ...headers } });
}
describe("Linode HTTP boundaries", () => {
  it("rejects redirects without following a credential-bearing request", async () => {
    let calls = 0;
    const http = new LinodeHttp("secret", async (_url, init) => { calls++; expect(init?.redirect).toBe("manual"); return response({}, 302, { Location: "https://evil.test" }); });
    await expect(http.request("/profile")).rejects.toMatchObject({ code: "remote_identity_changed" }); expect(calls).toBe(1);
  });
  it.each(["//evil.test", "/profile#fragment", "/\\evil.test"])("rejects invalid route %s", async route => {
    const http = new LinodeHttp("secret", async () => { throw new Error("must not run"); });
    await expect(http.request(route)).rejects.toMatchObject({ code: "invalid_rotation_step" });
  });
  it.each([[401, "invalid_credentials"], [403, "permission_denied"], [404, "resource_not_found"], [400, "unknown_cloud_error"]])("normalizes status %s without leaking reason", async (status, code) => {
    const http = new LinodeHttp("secret", async () => response({ errors: [{ reason: "secret" }] }, Number(status)));
    const error = await http.request("/profile").catch(error => error);
    expect(error).toMatchObject({ code, retryable: false }); expect(JSON.stringify(error)).not.toContain("secret");
  });
  it("honors rate limit delay while refusing mutation retries", async () => {
    let calls = 0;
    const http = new LinodeHttp("secret", async () => { calls++; return response({}, 429, { "Retry-After": "12" }); });
    await expect(http.request("/profile")).rejects.toMatchObject({ code: "rate_limited", retryable: true, retryAfterMs: 12_000 });
    await expect(http.request("/linode/instances/42/ips", { method: "POST", body: { type: "ipv4", public: true } })).rejects.toMatchObject({ code: "rate_limited", retryable: false, retryAfterMs: 12_000 }); expect(calls).toBe(2);
  });
  it("reads complete paginated collections including empty intermediate pages", async () => {
    const http = new LinodeHttp("secret", async url => { const page = Number(new URL(String(url)).searchParams.get("page")); return response({ data: page === 2 ? [] : [{ id: page }], page, pages: 3, results: 2 }); });
    expect(await http.all("/account/events")).toEqual([{ id: 1 }, { id: 3 }]);
  });
  it.each(["page", "pages", "results"])("rejects incomplete or changing pagination %s", async key => {
    const http = new LinodeHttp("secret", async url => { const page = Number(new URL(String(url)).searchParams.get("page")); return response({ data: [{ id: page }], page, pages: 2, results: 2, ...(page === 2 ? { [key]: 3 } : {}) }); });
    await expect(http.all("/account/events")).rejects.toBeDefined();
  });
});
