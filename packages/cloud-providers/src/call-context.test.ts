import { expect, it } from "vitest";
import { LinodeHttp } from "./linode-http.js";
import { withCloudCallSignal } from "./call-context.js";

it("prevents a write after a delayed preflight completes past cancellation without cancelling another call", async () => {
  const controller = new AbortController();
  let finishRead!: (value: Response) => void;
  const slowRead = new Promise<Response>(resolve => { finishRead = resolve; });
  const writes: string[] = [];
  const response = () => new Response("{}", { headers: { "X-Customer-UUID": "test-account" } });
  const http = new LinodeHttp("offline-test", async (url, init) => {
    if (init?.method === "GET") return slowRead;
    writes.push(String(url));
    return response();
  });
  const running = withCloudCallSignal(controller.signal, async () => {
    await http.request("/preflight");
    await http.request("/mutation", { method: "POST" });
  });
  controller.abort();
  finishRead(response());
  await expect(running).rejects.toBeDefined();
  expect(writes).toEqual([]);
  await withCloudCallSignal(new AbortController().signal, () => http.request("/independent", { method: "POST" }));
  expect(writes).toEqual(["https://api.linode.com/v4/independent"]);
});
