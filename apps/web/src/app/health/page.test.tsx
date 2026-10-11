// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionProvider } from "../../components/session-context";
import { demoUser } from "../../lib/demo";
import { demoHealthPolicies, demoProbeGroups, demoProbes } from "../../lib/probe-demo";
import type { AddressHealthPolicy } from "../../lib/probe-types";
import HealthPage from "./page";

vi.mock("next/navigation", () => ({ usePathname: () => "/health", useRouter: () => ({ replace: () => undefined }) }));

let root: Root;
let container: HTMLDivElement;
let policies: AddressHealthPolicy[];
let deletes: { path: string; body: unknown }[];
let finish: (response: Response) => void;

const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text)!;
const deleteButton = () => document.querySelector<HTMLButtonElement>('button[aria-label="删除策略"]');
const dialog = () => document.querySelector('[role="dialog"]');
async function click(target: HTMLButtonElement) { await act(async () => { target.click(); }); }

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", class { addEventListener() {} removeEventListener() {} close() {} });
  policies = [{ ...demoHealthPolicies[0]!, slotId: null, endpointId: "endpoint-1", cloudTarget: null, state: null }];
  deletes = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (init.method === "DELETE") {
      deletes.push({ path, body: JSON.parse(init.body as string) });
      return new Promise<Response>(resolve => { finish = resolve; });
    }
    const response = path.endsWith("/auth/me") ? { ...demoUser, role: "user" } : path.endsWith("/address-health-policies") ? policies
      : path.endsWith("/probes") ? demoProbes : path.endsWith("/probe-groups") ? demoProbeGroups : [];
    return Promise.resolve(Response.json(response));
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => { root.render(<SessionProvider><HealthPage /></SessionProvider>); });
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

it("offers deletion for ordinary users and cancels without a request", async () => {
  expect(deleteButton()).not.toBeNull();
  await click(deleteButton()!);
  expect(dialog()?.textContent).toContain("本地健康检查");
  expect(dialog()?.textContent).toContain("IPv4");
  await click(button("取消"));
  expect(dialog()).toBeNull(); expect(deletes).toEqual([]); expect(deleteButton()).not.toBeNull();
});

it("confirms once with the displayed revision and removes the policy from the list", async () => {
  await click(deleteButton()!); await click(button("确认删除"));
  expect(deletes).toEqual([{ path: "/api/v1/address-health-policies/policy-slot-v4", body: { expectedRevision: 2 } }]);
  expect(button("删除中").disabled).toBe(true);
  await click(button("删除中")); expect(deletes).toHaveLength(1);
  policies = [];
  await act(async () => { finish(Response.json({ deleted: true })); });
  expect(dialog()).toBeNull(); expect(deleteButton()).toBeNull();
  expect(container.textContent).toContain("暂无当前地址健康策略");
});

it("retains the policy and explains rotation conflicts, allowing retry", async () => {
  await click(deleteButton()!); await click(button("确认删除"));
  await act(async () => { finish(Response.json({ error: { code: "conflict", message: "请先关闭该地址族的定时轮换" } }, { status: 409 })); });
  expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain("请先关闭该地址族的定时轮换");
  expect(deleteButton()).not.toBeNull(); expect(button("确认删除").disabled).toBe(false);
  await click(button("确认删除")); expect(deletes).toHaveLength(2);
});

it("ignores a successful deletion response after leaving the page", async () => {
  await click(deleteButton()!); await click(button("确认删除"));
  await act(async () => { root.render(null); });
  await act(async () => { finish(Response.json({ deleted: true })); });
  expect(document.querySelector('[role="alert"]')).toBeNull(); expect(deletes).toHaveLength(1);
});
