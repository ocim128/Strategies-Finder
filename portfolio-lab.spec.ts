import { expect } from "chai";
import { describe, it } from "node:test";
import type { Signal, Time } from "./lib/strategies";
import {
    buildPortfolioSignalPresenceLookup,
    buildRunnablePortfolioUniverse,
    resolveLatestPortfolioSignalType,
    resolvePortfolioSignalType,
} from "./lib/portfolio-lab-helpers";

describe("Portfolio Lab helpers", () => {
    it("builds a runnable current-universe even when benchmark matches the current symbol", () => {
        const universe = buildRunnablePortfolioUniverse("ETHUSDT", "ETHUSDT", ["BTCUSDT", "SOLUSDT"]);

        expect(universe).to.deep.equal(["ETHUSDT", "BTCUSDT"]);
    });

    it("keeps a distinct benchmark in the minimal runnable universe", () => {
        const universe = buildRunnablePortfolioUniverse("ETHUSDT", "BTCUSDT", ["SOLUSDT", "ADAUSDT"]);

        expect(universe).to.deep.equal(["ETHUSDT", "BTCUSDT"]);
    });

    it("preserves same-bar buy and sell presence instead of overwriting one side", () => {
        const signals: Signal[] = [
            { time: "2023-01-02" as Time, type: "buy", price: 100 },
            { time: "2023-01-02" as Time, type: "sell", price: 100 },
        ];

        const lookup = buildPortfolioSignalPresenceLookup(signals);
        const presence = lookup.get("2023-01-02");

        expect(presence).to.deep.equal({ buy: true, sell: true });
        expect(resolvePortfolioSignalType(presence)).to.equal(null);
    });

    it("uses the latest unambiguous peer signal in the lag window", () => {
        const signals: Signal[] = [
            { time: "2023-01-02" as Time, type: "buy", price: 100 },
            { time: "2023-01-03" as Time, type: "sell", price: 101 },
        ];

        const lookup = buildPortfolioSignalPresenceLookup(signals);
        const latestType = resolveLatestPortfolioSignalType(["2023-01-02", "2023-01-03"], lookup);

        expect(latestType).to.equal("sell");
    });

    it("treats a latest same-bar conflict as ambiguous instead of forcing agree or oppose", () => {
        const signals: Signal[] = [
            { time: "2023-01-02" as Time, type: "buy", price: 100 },
            { time: "2023-01-03" as Time, type: "buy", price: 101 },
            { time: "2023-01-03" as Time, type: "sell", price: 101 },
        ];

        const lookup = buildPortfolioSignalPresenceLookup(signals);
        const latestType = resolveLatestPortfolioSignalType(["2023-01-02", "2023-01-03"], lookup);

        expect(latestType).to.equal(null);
    });
});
