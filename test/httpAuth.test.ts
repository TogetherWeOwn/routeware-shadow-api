import { describe, expect, it } from "vitest";
import { extractAntiForgeryFromExtNet } from "../src/lib/httpAuth";

describe("extractAntiForgeryFromExtNet", () => {
  it("extracts the token from an Ext.NET init hidden field", () => {
    const js =
      'items:[{xtype:"hiddenfield",name:"__RequestVerificationToken",value:"TOK-123abc"},{id:"UserName"}]';
    expect(extractAntiForgeryFromExtNet(js)).toBe("TOK-123abc");
  });

  it("falls back to an HTML hidden input", () => {
    const html =
      '<form><input name="__RequestVerificationToken" type="hidden" value="HTML-TOK" /></form>';
    expect(extractAntiForgeryFromExtNet(html)).toBe("HTML-TOK");
  });

  it("returns null when no token is present", () => {
    expect(extractAntiForgeryFromExtNet("nothing to see")).toBeNull();
  });
});
