// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SessionProvider } from "../../components/session-context";
import { demoOperations, demoUser } from "../../lib/demo";
import OperationsPage from "./page";

vi.mock("next/navigation", () => ({ usePathname: () => "/operations", useRouter: () => ({ replace: () => undefined }) }));

let root: Root;
let container: HTMLDivElement;
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  container?.remove();
  vi.unstubAllGlobals();
});

it.each([
  "Cloud publication authorization or address changed",
  "Cloudflare rejected the DNS record (HTTP 400; code 9000 at /content)",
])("shows the stored failure detail when opening an operation: %s", async errorDetail => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", class { addEventListener() {} removeEventListener() {} close() {} });
  const operation = { ...demoOperations[0]!, status: "failed", errorCode: "validation_failed" };
  vi.stubGlobal("fetch", (url: string) => {
    const path = new URL(url).pathname;
    const result = path.endsWith("/auth/me") ? demoUser : path.endsWith(`/operations/${operation.id}`) ? {
      ...operation, steps: [{ id: "step", sequence: 1, action: "update", status: "failed", attempts: 1, errorCode: "validation_failed", errorDetail, remoteSnapshot: null }],
    } : path.endsWith("/operations") ? [operation] : [];
    return Promise.resolve(Response.json(result));
  });
  window.history.replaceState(null, "", "/operations");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => { root.render(<SessionProvider><OperationsPage /></SessionProvider>); });
  const open = container.querySelector<HTMLButtonElement>('button[aria-label="查看操作详情"]');
  expect(open).not.toBeNull();
  await act(async () => { open!.click(); });
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.textContent).toContain("validation_failed");
  expect(dialog?.textContent).toContain(errorDetail);
});
