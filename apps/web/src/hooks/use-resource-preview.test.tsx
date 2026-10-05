// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useResource } from "./use-resource";

vi.hoisted(() => { vi.stubEnv("NEXT_PUBLIC_UI_PREVIEW", "true"); });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("keeps preview data locally editable and reloads the latest preview without fetching", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const networkRequests: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    networkRequests.push(url);
    return Response.json("unexpected network data");
  });
  let resource!: ReturnType<typeof useResource<string>>;
  function Consumer({ preview }: { preview: string }) {
    resource = useResource("/v1/preview", preview);
    return <output>{JSON.stringify({ data: resource.data, loading: resource.loading, error: resource.error })}</output>;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<Consumer preview="preview" />); });
    expect(JSON.parse(container.textContent!)).toEqual({ data: "preview", loading: false, error: null });
    await act(async () => { resource.setData(value => `${value} edited`); });
    await act(async () => { window.dispatchEvent(new Event("masterdns:invalidate")); });
    expect(JSON.parse(container.textContent!)).toEqual({ data: "preview edited", loading: false, error: null });
    await act(async () => { root.render(<Consumer preview="new preview" />); });
    await act(async () => { await resource.reload(); });
    expect(JSON.parse(container.textContent!)).toEqual({ data: "new preview", loading: false, error: null });
    expect(networkRequests).toEqual([]);
  } finally {
    await act(async () => { root.unmount(); });
  }
});
