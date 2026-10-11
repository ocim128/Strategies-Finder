import type { PercentageTakeProfitMode } from "./types/strategies";

/**
 * Take profit is always a static percentage target. Any unknown/legacy value
 * (including removed adaptive modes) collapses to `fixed`.
 */
export function resolveTakeProfitMode(value: unknown): PercentageTakeProfitMode {
    void value;
    return "fixed";
}
