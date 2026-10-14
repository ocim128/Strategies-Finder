import { expect } from "chai";
import { describe, it } from "node:test";
import { formatError } from "../lib/error-format";

describe("formatError", () => {
    it("renders name and message for Error instances", () => {
        expect(formatError(new TypeError("bad input"))).to.equal("TypeError: bad input");
        expect(formatError(new Error(""))).to.equal("Error: ");
    });

    it("falls back to String for non-Error values", () => {
        expect(formatError("boom")).to.equal("boom");
        expect(formatError(42)).to.equal("42");
        expect(formatError(null)).to.equal("null");
        expect(formatError(undefined)).to.equal("undefined");
    });

    it("uses String for Error-like objects that are not Error instances", () => {
        const errorLike = { name: "Custom", message: "shaped" };
        expect(formatError(errorLike)).to.equal("[object Object]");
    });
});
