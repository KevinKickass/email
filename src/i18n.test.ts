import { describe, expect, it } from "vitest";
import { resolveLanguage, translate } from "./i18n";
import en from "./locales/en.json";
import ts from "typescript";
import { readFileSync } from "node:fs";

describe("German and English", () => {
  it("respects explicit choices and detects system locales with an English fallback", () => {
    expect(resolveLanguage("system", "de-AT")).toBe("de");
    expect(resolveLanguage("system", "en-US")).toBe("en");
    expect(resolveLanguage("system", "fr-FR")).toBe("en");
    expect(resolveLanguage("en", "de-DE")).toBe("en");
    expect(translate("{count} Elemente", "en", { count: 12 })).toBe(
      "Items: 12",
    );
    expect(translate("{count} Elemente", "de", { count: 12 })).toBe(
      "12 Elemente",
    );
  });
  it("has English text and matching placeholders for every static translation call", () => {
    const missing: string[] = [];
    for (const file of ["src/App.tsx", "src/SettingsDialog.tsx"]) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      function visit(node: ts.Node) {
        if (
          ts.isCallExpression(node) &&
          node.expression.getText(source) === "t" &&
          node.arguments[0] &&
          ts.isStringLiteral(node.arguments[0])
        ) {
          const key = node.arguments[0].text;
          if (!(key in en)) missing.push(key);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    expect(missing).toEqual([]);
    for (const [key, value] of Object.entries(en)) {
      expect(value.length, key).toBeGreaterThan(0);
      expect(value.match(/\{\w+\}/g)?.sort() ?? [], key).toEqual(
        key.match(/\{\w+\}/g)?.sort() ?? [],
      );
    }
  });
});
