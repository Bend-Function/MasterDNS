import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LifecycleActionControls, LifecycleDeleteConfirmation } from "./cloud-instance-lifecycle";

describe("cloud instance lifecycle controls", () => {
  it("keeps all operations visible and disables unauthorized operations with their saved-policy reason", () => {
    const html = renderToStaticMarkup(createElement(LifecycleActionControls, {
      reasons: { start: "请先保存实例启动和停止授权", stop: "请先保存实例启动和停止授权", delete: "请先保存云实例删除授权" },
      busy: false,
      onSelect: () => undefined,
    }));
    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect(html).toContain("启动实例");
    expect(html).toContain("停止实例");
    expect(html).toContain("删除实例");
  });

  it("names the exact deletion target and warns about native data deletion and independent charges", () => {
    const html = renderToStaticMarkup(createElement(LifecycleDeleteConfirmation, {
      externalId: "i-0abc123",
      value: "i-0abc123",
      busy: false,
      onChange: () => undefined,
      onCancel: () => undefined,
      onConfirm: () => undefined,
    }));
    expect(html).toContain("i-0abc123");
    expect(html).toMatch(/磁盘.*数据/);
    expect(html).toMatch(/独立资源.*收费/);
    expect(html).toContain("value=\"i-0abc123\"");
    expect(html).not.toContain("disabled=\"\"");
  });
});
