import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Switch } from "./ui";

describe("Switch", () => {
  it("exposes its checked state to assistive technology", () => {
    const markup = renderToStaticMarkup(createElement(Switch, { checked: true, label: "启用渠道" }));

    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain('aria-label="启用渠道"');
  });
});
