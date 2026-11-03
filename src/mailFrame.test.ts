// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { bindMailFrame, displayMailImages } from "./mailFrame";

describe("trusted mail frame handlers", () => {
  function fixture() {
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML =
      '<p>Visit <a data-mail-link="0"><strong>our page</strong></a>.</p><a data-mail-link="99">unknown</a><img data-mail-image="0" alt="Logo"><table data-mail-background="0"></table>';
    return doc;
  }
  it("preserves link text, previews its actual destination and handles click and Enter without navigation", () => {
    const doc = fixture();
    const open = vi.fn();
    const preview = vi.fn();
    const dispose = bindMailFrame(
      doc,
      ["https://example.org/actual"],
      false,
      open,
      preview,
    );
    const link = doc.querySelector("a")!;
    expect(link.textContent).toBe("our page");
    expect(link.getAttribute("href")).toBeNull();
    expect(link.title).toBe("https://example.org/actual");
    link.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(preview).toHaveBeenLastCalledWith("https://example.org/actual");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.querySelector("strong")!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(open).toHaveBeenLastCalledWith("https://example.org/actual");
    link.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(open).toHaveBeenCalledTimes(2);
    link.dispatchEvent(
      new MouseEvent("auxclick", { button: 2, bubbles: true }),
    );
    expect(open).toHaveBeenCalledTimes(2);
    dispose();
    link.click();
    expect(open).toHaveBeenCalledTimes(2);
  });
  it("never opens unknown indices, unsafe schemes or demo links", () => {
    const doc = fixture();
    const open = vi.fn();
    bindMailFrame(doc, ["javascript:alert(1)"], false, open, vi.fn());
    doc.querySelector("a")!.click();
    doc.querySelectorAll("a")[1].click();
    expect(open).not.toHaveBeenCalled();
    const demo = fixture();
    bindMailFrame(demo, ["https://example.org/"], true, open, vi.fn());
    demo.querySelector("a")!.click();
    expect(open).not.toHaveBeenCalled();
  });
  it("inserts only approved raster data and removes it when blocked again", () => {
    const doc = fixture();
    const image = doc.querySelector("img")!;
    displayMailImages(doc, []);
    expect(image.hasAttribute("src")).toBe(false);
    for (const url of [
      "https://tracking.example/pixel",
      "data:image/svg+xml;base64,PHN2Zz4=",
    ]) {
      displayMailImages(doc, [{ index: 0, dataUrl: url }]);
      expect(image.hasAttribute("src")).toBe(false);
    }
    displayMailImages(doc, [
      { index: 0, dataUrl: "data:image/png;base64,iVBORw==" },
    ]);
    expect(image.getAttribute("src")).toBe("data:image/png;base64,iVBORw==");
    expect(doc.querySelector("table")!.style.backgroundImage).toContain(
      "data:image/png",
    );
    displayMailImages(doc, []);
    expect(image.hasAttribute("src")).toBe(false);
    expect(doc.querySelector("table")!.style.backgroundImage).toBe("");
  });
});
