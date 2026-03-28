import { selectExecutionAwareClosedCandles } from "./alert-evaluation-window";
import type { BacktestSettings, OHLCVData } from "./types/strategies";

export function selectLatestEntryExportCandles(
    candles: OHLCVData[],
    interval: string,
    backtestSettings: BacktestSettings,
    nowSec: number = Math.floor(Date.now() / 1000)
): OHLCVData[] | null {
    return selectExecutionAwareClosedCandles(
        candles,
        interval,
        backtestSettings,
        {
            nowSec,
            minClosedCandles: 2,
            fallbackToTrimmedClosed: true,
        }
    );
}
