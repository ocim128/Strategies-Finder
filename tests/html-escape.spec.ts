import { expect } from "chai";
import { describe, it } from "node:test";
import { escapeHtml } from "../lib/html-escape";

describe("escapeHtml", () => {
    it("neutralizes an img-onerror XSS fixture and non-string values", () => {
        const payload = `<img src=x onerror=alert(1)>`;
        const escaped = escapeHtml(payload);
        expect(escaped).to.equal("&lt;img src=x onerror=alert(1)&gt;");
        expect(escaped).to.not.include("<img");
        expect(escapeHtml(null)).to.equal("");
        expect(escapeHtml(12)).to.equal("12");
        expect(escapeHtml(`a&b"c'd`)).to.equal("a&amp;b&quot;c&#39;d");
    });
});
