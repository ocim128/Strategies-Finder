import type { PolymarketClob1sQuoteRow } from "../second-market/types";
import type { StrategyExecutionContext } from "../types/strategies";
import type { ExecutionLabSessionSnapshot } from "./execution-lab-model";

export function buildExecutionLabStrategyExecutionContext(args: {
    snapshot: ExecutionLabSessionSnapshot;
    quotes: readonly PolymarketClob1sQuoteRow[];
}): StrategyExecutionContext | undefined {
    if (args.quotes.length === 0) return undefined;
    return {
        polymarket1s: {
            symbol: args.snapshot.symbol,
            outcomeSymbol: args.snapshot.outcomeSymbol,
            seriesId: args.snapshot.seriesId,
            outcomeInterval: args.snapshot.outcomeInterval,
            quotes: args.quotes,
            gammaSnapshots: [],
        },
    };
}
