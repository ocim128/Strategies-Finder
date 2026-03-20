
import type { OHLCVData, Signal, StrategyParams } from "./types/strategies";

type IndicatorHelpers = typeof import("./strategies/indicators");

// Helper for safely executing dynamic strategy code
export class StrategyExecutor {
    private static readonly validateFnString = `
        "use strict"; 
        return function(data, params, indicators) { 
            return (function(data, params, indicators) {
                // User code text
                CODE_PLACEHOLDER
            })(data, params, indicators); 
        }`;

    /**
     * Tries to compile the code string into a runnable function.
     * Throws if syntax is invalid.
     */
    public static compile(code: string): void {
        const fullBody = this.validateFnString.replace('CODE_PLACEHOLDER', code);
        new Function(fullBody);
    }

    /**
     * Executes the strategy code.
     */
    public static execute(
        code: string,
        data: OHLCVData[],
        params: StrategyParams,
        indicators: IndicatorHelpers
    ): Signal[] {
        const fullBody = this.validateFnString.replace('CODE_PLACEHOLDER', code);
        const fn = new Function(fullBody)() as (
            data: OHLCVData[],
            params: StrategyParams,
            indicators: IndicatorHelpers
        ) => Signal[];
        return fn(data, params, indicators);
    }
}
