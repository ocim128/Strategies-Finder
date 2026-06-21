import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTrustedLocalRequest } from "../lib/local-sqlite-vite-plugin";

describe("local sqlite vite plugin", () => {
    it("rejects requests without local origin or referer headers", () => {
        assert.equal(isTrustedLocalRequest({ headers: {} }), false);
    });

    it("allows localhost origin requests without a bearer token", () => {
        assert.equal(isTrustedLocalRequest({
            headers: { origin: "http://localhost:5173" },
        }), true);
    });

    it("allows localhost referer requests without a bearer token", () => {
        assert.equal(isTrustedLocalRequest({
            headers: { referer: "http://127.0.0.1:5173/chart" },
        }), true);
    });
});
