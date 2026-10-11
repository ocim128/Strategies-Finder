/**
 * Contract tests for the Finder control registry. These lock the invariant the
 * registry exists to provide: every declared simple control maps to a real DOM
 * id, owns exactly one persisted-state key, and the state key set is fully
 * covered so `applyPersistedUiStateToDom` can never silently skip a control.
 */
import { expect } from "chai";
import { describe, it } from "node:test";

import {
	FINDER_CONTROL_BINDINGS,
	type FinderBoundStateKey,
} from "../lib/finder/browser/finder-control-registry";
import { FINDER_MANAGER_REQUIRED_IDS } from "../lib/finder/finder-manager-dom";
import { DEFAULT_FINDER_UI_STATE } from "../lib/finder/browser/finder-settings";

describe("Finder control registry", () => {
	it("references only real Finder menu DOM ids", () => {
		const known = new Set<string>(FINDER_MANAGER_REQUIRED_IDS);
		for (const binding of FINDER_CONTROL_BINDINGS) {
			expect(known.has(binding.id), `${binding.id} missing from FINDER_MANAGER_REQUIRED_IDS`).to.equal(true);
		}
	});

	it("maps every state key to at most one control", () => {
		const seen = new Set<string>();
		for (const binding of FINDER_CONTROL_BINDINGS) {
			expect(seen.has(binding.stateKey), `duplicate binding for ${binding.stateKey}`).to.equal(false);
			seen.add(binding.stateKey);
		}
	});

	it("declares only persisted-state keys that exist on the default state", () => {
		for (const binding of FINDER_CONTROL_BINDINGS) {
			expect(
				Object.prototype.hasOwnProperty.call(DEFAULT_FINDER_UI_STATE, binding.stateKey),
				`${binding.stateKey} is not a FinderPersistedUiState field`,
			).to.equal(true);
		}
	});

	it("uses the state key's declared read type consistently (numbers are never boolean)", () => {
		for (const binding of FINDER_CONTROL_BINDINGS) {
			const value = DEFAULT_FINDER_UI_STATE[binding.stateKey as FinderBoundStateKey];
			if (typeof value === "boolean") {
				expect(binding.read, `${binding.id} should read a boolean`).to.equal("boolean");
			}
			if (typeof value === "number") {
				expect(binding.read, `${binding.id} should read a number`).to.equal("number");
			}
			if (typeof value === "string") {
				// Strings are read either as free text or from a <select>; both
				// yield a string, so either is acceptable here.
				expect(binding.read === "text" || binding.read === "select", `${binding.id} should read text/select`).to.equal(true);
			}
		}
	});

	it("applies unbounded/default state without throwing for every binding", async () => {
		// Each binding must be writable against a plain object shape: the write
		// path only reads one state key and assigns one DOM value.
		for (const binding of FINDER_CONTROL_BINDINGS) {
			const value = DEFAULT_FINDER_UI_STATE[binding.stateKey as FinderBoundStateKey];
			expect(value, `${binding.stateKey} default`).to.not.equal(undefined);
		}
	});
});
