/**
 * Monte Carlo's required DOM contract: every declared control must resolve or
 * initialization fails before any side effect. Missing controls used to fall
 * back to unrelated elements (Cancel became Run, Seed became the simulations
 * input), so those ids are the regression fixtures, and initialization wiring
 * (control listeners, window listeners, state subscriptions) is counted
 * directly instead of being inferred from dispatched events.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMonteCarloDom, MONTE_CARLO_REQUIRED_IDS } from "../lib/monte-carlo-dom";
import { initMonteCarloService } from "../lib/monte-carlo-service";
import { state } from "../lib/state";
import { createFakeElement } from "./helpers/fake-element";

describe("Monte Carlo required DOM contract", () => {
    for (const missingId of ["mc-cancel-btn", "mc-seed"] as const) {
        it(`fails initialization when ${missingId} is missing instead of aliasing another element`, () => {
            const elements = new Map<string, ReturnType<typeof createFakeElement>>();
            for (const id of MONTE_CARLO_REQUIRED_IDS) {
                if (id === missingId) continue;
                elements.set(id, createFakeElement());
            }

            let controlListenerCount = 0;
            for (const element of elements.values()) {
                const originalAddEventListener = element.addEventListener.bind(element);
                element.addEventListener = (...args: Parameters<typeof element.addEventListener>) => {
                    controlListenerCount += 1;
                    originalAddEventListener(...args);
                };
            }

            let windowListenerCount = 0;
            const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
            const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
            Object.defineProperty(globalThis, "document", {
                configurable: true,
                value: { getElementById: (id: string) => elements.get(id) ?? null },
            });
            Object.defineProperty(globalThis, "window", {
                configurable: true,
                value: {
                    addEventListener: () => {
                        windowListenerCount += 1;
                    },
                },
            });

            const originalStateSubscribe = state.subscribe;
            let stateSubscriptionCount = 0;
            state.subscribe = ((...args: Parameters<typeof originalStateSubscribe>) => {
                stateSubscriptionCount += 1;
                return originalStateSubscribe.apply(state, args);
            }) as typeof state.subscribe;

            try {
                assert.throws(
                    () => createMonteCarloDom(),
                    (error: unknown) => error instanceof Error && error.message.includes(missingId),
                    "the DOM contract must name the missing control",
                );

                let serviceError: unknown = null;
                try {
                    initMonteCarloService();
                } catch (error) {
                    serviceError = error;
                }
                assert.ok(
                    serviceError instanceof Error && serviceError.message.includes(missingId),
                    "initialization must fail naming the missing control",
                );

                // A failed contract must have zero side effects: no control
                // listener of any event type, no window listener, no state
                // subscription.
                assert.equal(controlListenerCount, 0, `no control listener may be registered after the failed contract (${missingId})`);
                assert.equal(windowListenerCount, 0, `no window listener may be registered after the failed contract (${missingId})`);
                assert.equal(stateSubscriptionCount, 0, `no state subscription may be registered after the failed contract (${missingId})`);

                // Defense in depth: dispatching still reaches nothing.
                for (const element of elements.values()) {
                    assert.equal(element.click(), false, `no listener may be attached after the failed contract (${missingId})`);
                }
                assert.equal(elements.get("mc-status")!.textContent, "", "the run handler must not have executed");
            } finally {
                state.subscribe = originalStateSubscribe;
                if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
                else Reflect.deleteProperty(globalThis, "window");
                if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
                else Reflect.deleteProperty(globalThis, "document");
            }
        });
    }
});
