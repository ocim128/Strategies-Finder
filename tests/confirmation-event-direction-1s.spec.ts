import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Signal, Time } from "../lib/types/strategies";
import { applyConfirmationStrategiesToSignals } from "../lib/confirmation-signal-filter";
import { registerLoadedBuiltInStrategy, unregisterLoadedBuiltInStrategy } from "../lib/strategies/built-in-catalog";
import { event_direction_1s } from "../lib/strategies/lib/event_direction_1s";

const EVENT_START = 1_700_001_000;

function makeBars(count: number, basePrice: number, closeOffset: number): OHLCVData[] {
    const bars: OHLCVData[] = [];
    for (let s = 0; s < count; s++) {
        bars.push({
            time: (EVENT_START + s) as Time,
            open: basePrice,
            high: basePrice + 1,
            low: basePrice - 1,
            close: basePrice + closeOffset,
            volume: 1000,
        });
    }
    return bars;
}

describe("confirmation with event_direction_1s", () => {
    it("keeps buy signal when confirmation also buys (close > event open)", () => {
        registerLoadedBuiltInStrategy("event_direction_1s", event_direction_1s);

        // Price above event open -> confirmation fires BUY
        const bars = makeBars(10, 100, 0.5);

        const baseSignals: Signal[] = [
            { time: bars[5]!.time, type: "buy", price: bars[5]!.close, barIndex: 5 },
        ];

        const result = applyConfirmationStrategiesToSignals({
            data: bars,
            baseSignals,
            settings: {
                confirmationStrategies: ["event_direction_1s"],
                confirmationStrategyParams: { event_direction_1s: { minSecondsToEventEnd: 0 } },
            } as any,
        });

        expect(result.length).to.equal(1);
        unregisterLoadedBuiltInStrategy("event_direction_1s");
    });

    it("drops buy signal when confirmation fires sell (close < event open)", () => {
        registerLoadedBuiltInStrategy("event_direction_1s", event_direction_1s);

        // Price below event open -> confirmation fires SELL
        const bars = makeBars(10, 100, -0.5);

        const baseSignals: Signal[] = [
            { time: bars[5]!.time, type: "buy", price: bars[5]!.close, barIndex: 5 },
        ];

        const result = applyConfirmationStrategiesToSignals({
            data: bars,
            baseSignals,
            settings: {
                confirmationStrategies: ["event_direction_1s"],
                confirmationStrategyParams: { event_direction_1s: { minSecondsToEventEnd: 0 } },
            } as any,
        });

        expect(result.length).to.equal(0);
        unregisterLoadedBuiltInStrategy("event_direction_1s");
    });

    it("returns base signals unchanged when no confirmation strategies", () => {
        const bars = makeBars(10, 100, 0.5);
        const baseSignals: Signal[] = [
            { time: bars[5]!.time, type: "buy", price: bars[5]!.close, barIndex: 5 },
        ];

        const result = applyConfirmationStrategiesToSignals({
            data: bars,
            baseSignals,
            settings: {
                confirmationStrategies: [],
                confirmationStrategyParams: {},
            } as any,
        });

        expect(result.length).to.equal(1);
    });

    it("keeps buy signal in veto_opposite mode when confirmation agrees", () => {
        registerLoadedBuiltInStrategy("event_direction_1s", event_direction_1s);

        const bars = makeBars(10, 100, 0.5);
        const baseSignals: Signal[] = [
            { time: bars[5]!.time, type: "buy", price: bars[5]!.close, barIndex: 5 },
        ];

        const result = applyConfirmationStrategiesToSignals({
            data: bars,
            baseSignals,
            settings: {
                confirmationStrategies: ["event_direction_1s"],
                confirmationMode: "veto_opposite",
                confirmationStrategyParams: { event_direction_1s: { minSecondsToEventEnd: 0 } },
            } as any,
        });

        expect(result.length).to.equal(1);
        unregisterLoadedBuiltInStrategy("event_direction_1s");
    });

    it("keeps buy signal in confirm_within_window mode when matching confirmation is nearby", () => {
        const bars = makeBars(10, 100, 0.5);
        const baseSignals: Signal[] = [
            { time: bars[5]!.time, type: "buy", price: bars[5]!.close, barIndex: 5 },
        ];

        const result = applyConfirmationStrategiesToSignals({
            data: bars,
            baseSignals,
            settings: {
                confirmationStrategies: ["manual_confirm"],
                confirmationMode: "confirm_within_window",
                confirmationWindowBars: 1,
                confirmationStrategyParams: {},
            } as any,
            resolveStrategy: () => ({
                name: "Manual Confirm",
                description: "test",
                defaultParams: {},
                paramLabels: {},
                execute: () => [{ time: bars[4]!.time, type: "buy", price: bars[4]!.close, barIndex: 4 }],
            }),
        });

        expect(result.length).to.equal(1);
    });

    it("drops buy signal in veto_within_window mode when opposite confirmation is nearby", () => {
        const bars = makeBars(10, 100, 0.5);
        const baseSignals: Signal[] = [
            { time: bars[5]!.time, type: "buy", price: bars[5]!.close, barIndex: 5 },
        ];

        const result = applyConfirmationStrategiesToSignals({
            data: bars,
            baseSignals,
            settings: {
                confirmationStrategies: ["manual_veto"],
                confirmationMode: "veto_within_window",
                confirmationWindowBars: 1,
                confirmationStrategyParams: {},
            } as any,
            resolveStrategy: () => ({
                name: "Manual Veto",
                description: "test",
                defaultParams: {},
                paramLabels: {},
                execute: () => [{ time: bars[6]!.time, type: "sell", price: bars[6]!.close, barIndex: 6 }],
            }),
        });

        expect(result.length).to.equal(0);
    });
});
