// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderAccount, ZoneListRow } from "../lib/types";
import { ZoneCreateDialog } from "./zone-create-dialog";

const account: ProviderAccount = { id: "3ebae6b0-ff56-4dd0-a1f4-42b8af07aa65", ownerUserId: "owner", provider: "cloudflare", name: "Production", status: "active", credentialHint: "API Token", errorCode: null, lastVerifiedAt: null, lastSyncedAt: null, createdAt: "2026-10-11" };
const zones: ZoneListRow[] = [{ zone: { id: "old-zone", providerAccountId: account.id, nameAscii: "old.com", status: "active", lastSyncedAt: null, providerMetadata: { accountId: "a".repeat(32) } }, accountName: account.name, provider: "cloudflare", ownerUserId: "owner" }];
const success = (name: string) => ({ name, status: "created", zoneId: `zone-${name}`, zoneStatus: "pending", nameServers: ["amy.ns.cloudflare.com", "bob.ns.cloudflare.com"] });

describe("domain creation dialog", () => {
  let root: Root;
  let container: HTMLDivElement;
  let requests: { path: string; body: Record<string, unknown> }[];
  let changed: number;
  let closed: number;
  let respond: (name: string) => Response | Promise<Response>;
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label)!;
  const submit = async () => { await act(async () => { document.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); };
  async function type(selector: string, value: string) {
    await act(async () => {
      const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  const render = async (accounts = [account]) => { await act(async () => { root.render(<ZoneCreateDialog accounts={accounts} zones={zones} onClose={() => { closed++; }} onChanged={() => { changed++; }} />); }); };
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    requests = []; changed = 0; closed = 0;
    respond = name => Response.json(success(name));
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      requests.push({ path: new URL(url).pathname, body });
      return Promise.resolve(respond(String(body.name)));
    });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await render();
  });
  afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

  it("prefills the known Cloudflare account and submits one normalized domain", async () => {
    expect(document.querySelector<HTMLInputElement>('input[name="cloudflareAccountId"]')!.value).toBe("a".repeat(32));
    await type('input[name="name"]', " Example.COM. "); await submit();
    expect(requests).toEqual([{ path: "/api/v1/zones", body: { providerAccountId: account.id, cloudflareAccountId: "a".repeat(32), name: "example.com" } }]);
    expect(document.body.textContent).toContain("amy.ns.cloudflare.com");
    expect(document.body.textContent).toContain("域名注册商");
    expect(changed).toBe(1); expect(closed).toBe(0);
  });

  it("continues after a batch item fails, shows each result and retries only failures", async () => {
    await act(async () => { button("批量添加").click(); });
    await type('textarea[name="names"]', "A.COM\na.com.\ndenied.com\nb.com");
    respond = name => name === "denied.com" ? Response.json({ error: { code: "permission_denied", message: "权限不足" } }, { status: 403 }) : Response.json(success(name));
    await submit();
    expect(requests.map(request => request.body.name)).toEqual(["a.com", "denied.com", "b.com"]);
    expect(document.body.textContent).toContain("权限");
    expect(document.body.textContent).toContain("b.com");
    expect(document.body.textContent).toContain("1 个失败");
    respond = name => Response.json(success(name));
    await act(async () => { button("重试失败项").click(); });
    expect(requests.map(request => request.body.name)).toEqual(["a.com", "denied.com", "b.com", "denied.com"]);
    expect(document.body.textContent).toContain("0 个失败");
  });

  it("validates the entire batch before issuing its first create request", async () => {
    await act(async () => { button("批量添加").click(); });
    await type('textarea[name="names"]', "valid.com\nhttps://invalid.com"); await submit();
    expect(requests).toEqual([]);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("有效域名");
  });

  it("excludes disabled and unsupported accounts and directs users to connect Cloudflare", async () => {
    await render([{ ...account, status: "disabled" }, { ...account, id: "aliyun", provider: "aliyun" }]);
    expect(document.querySelectorAll("select option")).toHaveLength(1);
    expect(button("添加域名").disabled).toBe(true);
    expect(document.querySelector('a[href="/accounts"]')).not.toBeNull();
    await submit(); expect(requests).toEqual([]);
  });

  it("prevents repeat submission and closing while a domain request is running", async () => {
    let finish!: (response: Response) => void;
    respond = () => new Promise(resolve => { finish = resolve; });
    await type('input[name="name"]', "example.com"); await submit(); await submit();
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.click(); });
    expect(requests).toHaveLength(1); expect(closed).toBe(0);
    await act(async () => { finish(Response.json(success("example.com"))); });
    expect(changed).toBe(1);
  });

  it("stops further batch writes and ignores callbacks after navigation unmounts the dialog", async () => {
    let finish!: (response: Response) => void;
    respond = () => new Promise(resolve => { finish = resolve; });
    await act(async () => { button("批量添加").click(); });
    await type('textarea[name="names"]', "a.com\nb.com"); await submit();
    await act(async () => { root.render(null); finish(Response.json(success("a.com"))); });
    expect(requests).toHaveLength(1); expect(changed).toBe(0);
  });
});
