// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoCloudAccounts } from "../lib/cloud-demo";
import { CloudAccountDeleteDialog } from "./cloud-account-delete-dialog";

describe("local cloud account deletion", () => {
  let root: Root;
  let container: HTMLDivElement;
  let deleted: string[];
  let requests: { path: string; method: string | undefined }[];
  let finish: (response: Response) => void;

  const confirmButton = () => [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "删除账号及实例记录")!;
  async function typeName(value: string) {
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>("input")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function clickConfirm() { await act(async () => { confirmButton().click(); }); }
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    requests = []; deleted = [];
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      requests.push({ path: new URL(url).pathname, method: init.method });
      return new Promise<Response>(resolve => { finish = resolve; });
    });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root.render(<CloudAccountDeleteDialog account={demoCloudAccounts[0]!} onClose={() => undefined} onDeleted={id => { deleted.push(id); }} />); });
  });
  afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

  it("requires the exact account name before clearing local data and sends one DELETE", async () => {
    expect(document.body.textContent).toContain("不会销毁云厂商上的实际实例");
    expect(confirmButton().disabled).toBe(true);
    await typeName("wrong account"); await clickConfirm(); expect(requests).toEqual([]);
    await typeName(demoCloudAccounts[0]!.name); expect(confirmButton().disabled).toBe(false);
    await clickConfirm(); await clickConfirm();
    expect(requests).toEqual([{ path: "/api/v1/cloud-accounts/cloud-account-1", method: "DELETE" }]);
    expect(confirmButton().disabled).toBe(true);
    await act(async () => { finish(Response.json({ deleted: true, deletedInstances: 2 })); });
    expect(deleted).toEqual(["cloud-account-1"]);
  });

  it("keeps the dialog and account on failure and allows retry", async () => {
    await typeName(demoCloudAccounts[0]!.name); await clickConfirm();
    await act(async () => { finish(Response.json({ error: { message: "删除失败，请重试" } }, { status: 409 })); });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("删除失败，请重试");
    expect(deleted).toEqual([]); expect(confirmButton().disabled).toBe(false);
    await clickConfirm(); expect(requests).toHaveLength(2);
  });

  it("ignores a successful response after the dialog unmounts", async () => {
    await typeName(demoCloudAccounts[0]!.name); await clickConfirm();
    await act(async () => { root.render(null); });
    await act(async () => { finish(Response.json({ deleted: true, deletedInstances: 1 })); });
    expect(deleted).toEqual([]);
  });
});
