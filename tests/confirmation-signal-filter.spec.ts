import { expect } from "chai";
import { describe, it } from "node:test";
import {
    applyConfirmationStrategiesToSignals,
} from "../lib/confirmation-signal-filter";
import type { OHLCVData, Signal, Strategy, Time } from "../lib/types/strategies";

const confirmationStrategy: Strategy = {
    name: "Test Confirmation",
    description: "Test-only confirmation strategy",
    defaultParams: {},
    paramLabels: {},
    execute: () => [],
};

function signal(barIndex: number, type: Signal["type"]): Signal {
    return {
        time: (barIndex * 60) as Time,
        type,
        price: 100,
        barIndex,
    };
}

function data(): OHLCVData[] {
    return Array.from({ length: 4 }, (_, barIndex) => ({
        time: (barIndex * 60) as Time,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 1000,
    }));
}

describe("confirmation signal filter", () => {
    it("disagree keeps only base entries with an opposite same-bar confirmation", () => {
        const result = applyConfirmationStrategiesToSignals({
            data: data(),
            baseSignals: [
                signal(0, "buy"),
                signal(1, "sell"),
                signal(2, "buy"),
                signal(3, "sell"),
            ],
            settings: {
                confirmationStrategies: ["test_confirmation"],
                confirmationMode: "disagree",
            },
            resolveStrategy: () => confirmationStrategy,
            executeStrategy: () => [
                signal(0, "sell"),
                signal(1, "buy"),
                signal(2, "buy"),
                signal(3, "sell"),
            ],
        });

        expect(result).to.deep.equal([
            signal(0, "buy"),
            signal(1, "sell"),
        ]);
    });

    it("disagree remains same-bar even when a window is configured", () => {
        const result = applyConfirmationStrategiesToSignals({
            data: data(),
            baseSignals: [signal(1, "buy")],
            settings: {
                confirmationStrategies: ["test_confirmation"],
                confirmationMode: "disagree",
                confirmationWindowBars: 2,
            },
            resolveStrategy: () => confirmationStrategy,
            executeStrategy: () => [signal(0, "sell")],
        });

        expect(result).to.deep.equal([]);
    });
});
