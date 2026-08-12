import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../lib/types/strategies";
import { mcginley_dynamic_confirmation } from "../lib/strategies/lib/mcginley_dynamic_confirmation";

describe("McGinley Dynamic prepared execution", () => {
    it("keeps direct signals identical while reusing one prepared asset window", () => {
        const data: OHLCVData[] = Array.from({ length: 160 }, (_, index) => {
            const close = 100 + Math.sin(index / 7) * 3 + index * 0.08;
            return {
                time: (index + 1) as Time,
                open: close - 0.2,
                high: close + 0.8,
                low: close - 0.8,
                close,
                volume: 1000 + index,
            };
        });
        const prepared = mcginley_dynamic_confirmation.prepareFinderData!(data);

        for (const lookback of [5, 13, 40]) {
            const params = { lookback };
            const direct = mcginley_dynamic_confirmation.execute(data, params);
            const preparedSignals = mcginley_dynamic_confirmation.executePrepared!(prepared, params, data);
            expect(preparedSignals, `lookback ${lookback}`).to.deep.equal(direct);
        }
    });
});
