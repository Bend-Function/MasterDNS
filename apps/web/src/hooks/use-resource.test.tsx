// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useResource } from "./use-resource";

type Resource = ReturnType<typeof useResource<string>>;

function deferredResponse() {
  let resolve!: (value: Response) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Response>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve: (value: string) => resolve(Response.json(value)), reject };
}

describe("useResource request ordering", () => {
  let root: Root;
  let container: HTMLDivElement;
  let resource: Resource;
  let requests: ReturnType<typeof deferredResponse>[];
  let paths: string[];

  function Consumer({ path }: { path: string }) {
    resource = useResource(path, "preview");
    return <output>{JSON.stringify({ data: resource.data, loading: resource.loading, error: resource.error })}</output>;
  }

  async function render(path = "/v1/resources") {
    await act(async () => { root.render(<Consumer path={path} />); });
  }

  async function succeed(index: number, value: string) {
    await act(async () => { requests[index]!.resolve(value); });
  }

  async function fail(index: number) {
    await act(async () => { requests[index]!.reject(new Error("network failed")); });
  }

  async function reload() {
    await act(async () => { void resource.reload(); });
  }

  async function invalidate() {
    await act(async () => { window.dispatchEvent(new Event("masterdns:invalidate")); });
  }

  function expectState(data: string | null, loading = false, error: string | null = null) {
    expect(JSON.parse(container.textContent!)).toEqual({ data, loading, error });
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    requests = [];
    paths = [];
    // Keep the real API response/error handling; control only the network boundary.
    vi.stubGlobal("fetch", (url: string) => {
      paths.push(new URL(url).pathname);
      const request = deferredResponse();
      requests.push(request);
      return request.promise;
    });
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    vi.unstubAllGlobals();
  });

  it("keeps saved data when an older automatic refresh finishes after reload", async () => {
    await render();
    await succeed(0, "original");
    await invalidate();
    expectState("original");
    await reload();
    await succeed(2, "saved");
    await succeed(1, "outdated");
    expectState("saved");
  });

  it("ignores the initial response when a newer reload already succeeded", async () => {
    await render();
    await reload();
    await succeed(1, "saved");
    await succeed(0, "outdated");
    expectState("saved");
  });

  it("does not let an older initial failure end a pending reload or show an error", async () => {
    await render();
    await reload();
    await fail(0);
    expectState(null, true);
    await succeed(1, "saved");
    expectState("saved");
  });

  it("does not let an older reload change data or end a newer pending reload", async () => {
    await render();
    await succeed(0, "original");
    await reload();
    await reload();
    await succeed(1, "outdated");
    expectState("original", true);
    await succeed(2, "saved");
    expectState("saved");
  });

  it("ignores a stale reload error after a newer reload succeeds", async () => {
    await render();
    await succeed(0, "original");
    await reload();
    await reload();
    await succeed(2, "saved");
    await fail(1);
    expectState("saved");
  });

  it("orders successive invalidations by request start instead of completion", async () => {
    await render();
    await succeed(0, "original");
    await invalidate();
    await invalidate();
    await succeed(2, "latest");
    await succeed(1, "outdated");
    expectState("latest");
  });

  it("settles loading when an invalidation supersedes a foreground request", async () => {
    await render();
    await invalidate();
    await succeed(1, "latest");
    expectState("latest");
    await succeed(0, "outdated");
    expectState("latest");
  });

  it("keeps background failures silent while settling a superseded foreground request", async () => {
    await render();
    await succeed(0, "original");
    await reload();
    await invalidate();
    await fail(2);
    expectState("original");
    await fail(1);
    expectState("original");
  });

  it("ignores a manual reload from the previous path", async () => {
    await render("/v1/first");
    await succeed(0, "first");
    await reload();
    await render("/v1/second");
    await succeed(2, "second");
    await succeed(1, "outdated first");
    expectState("second");
    expect(paths).toEqual(["/api/v1/first", "/api/v1/first", "/api/v1/second"]);
  });

  it("ignores a retained reload callback after its path has changed", async () => {
    await render("/v1/first");
    const oldReload = resource.reload;
    await render("/v1/second");
    await act(async () => { void oldReload(); });
    await succeed(1, "second");
    expectState("second");
    expect(paths).toEqual(["/api/v1/first", "/api/v1/second"]);
  });

  it("stops starting requests after unmount", async () => {
    await render();
    const oldReload = resource.reload;
    await act(async () => { root.unmount(); });
    await act(async () => { void oldReload(); });
    await invalidate();
    expect(paths).toEqual(["/api/v1/resources"]);
    await succeed(0, "ignored");
  });

  it("reports current foreground errors and clears them when retrying", async () => {
    await render();
    await fail(0);
    expectState(null, false, "network failed");
    await reload();
    expectState(null, true);
    await succeed(1, "recovered");
    expectState("recovered");
    await act(async () => { resource.setData(value => `${value} locally edited`); });
    expectState("recovered locally edited");
  });
});
