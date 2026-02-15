import { btc_queen_v1, btc_queen_v1_backtest_overrides } from "../lib/strategies/lib/btc_queen_v1";
import { sol_queen_v1, sol_queen_v1_backtest_overrides } from "../lib/strategies/lib/sol_queen_v1";

type NumericMap = Record<string, number>;

function fail(message: string): never {
    throw new Error(`[EmpireIntegrity] ${message}`);
}

function assertExactNumericMap(
    name: string,
    actual: Record<string, unknown>,
    expected: NumericMap
): void {
    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(expected).sort();
    if (actualKeys.length !== expectedKeys.length) {
        fail(`${name} key count mismatch: actual=${actualKeys.length} expected=${expectedKeys.length}`);
    }
    for (let i = 0; i < expectedKeys.length; i++) {
        if (actualKeys[i] !== expectedKeys[i]) {
            fail(`${name} keys mismatch at index ${i}: actual=${actualKeys[i]} expected=${expectedKeys[i]}`);
        }
    }
    for (const key of expectedKeys) {
        const actualValue = Number(actual[key]);
        const expectedValue = expected[key];
        if (!Number.isFinite(actualValue)) {
            fail(`${name}.${key} is not a finite number`);
        }
        if (actualValue !== expectedValue) {
            fail(`${name}.${key} mismatch: actual=${actualValue} expected=${expectedValue}`);
        }
    }
}

function assertExactLiteralMap(
    name: string,
    actual: Record<string, unknown>,
    expected: Record<string, string | number>
): void {
    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(expected).sort();
    if (actualKeys.length !== expectedKeys.length) {
        fail(`${name} key count mismatch: actual=${actualKeys.length} expected=${expectedKeys.length}`);
    }
    for (let i = 0; i < expectedKeys.length; i++) {
        if (actualKeys[i] !== expectedKeys[i]) {
            fail(`${name} keys mismatch at index ${i}: actual=${actualKeys[i]} expected=${expectedKeys[i]}`);
        }
    }
    for (const key of expectedKeys) {
        const actualValue = actual[key];
        const expectedValue = expected[key];
        if (actualValue !== expectedValue) {
            fail(`${name}.${key} mismatch: actual=${String(actualValue)} expected=${String(expectedValue)}`);
        }
    }
}

const expectedSolDefaultParams: NumericMap = {
    volWindow: 21,
    volLookback: 126,
    fastPeriod: 50,
    slowPeriod: 200,
    useSpikeRegime: 1,
    useRecoveryRegime: 1,
    useLowVolDeRisk: 1,
    useMlOverlay: 1,
    adaptiveLookbacks: 0,
    adaptiveStrengthPct: 0,
    minAdaptiveFactor: 1,
    maxAdaptiveFactor: 1,
    spikePercentilePct: 80,
    calmPercentilePct: 25,
    oversoldRetPct: 3,
    extensionPct: 5,
    mlBullThresholdPct: 60,
    entryExposurePct: 60.0518,
    exitExposurePct: 37.4696,
    entryConfirmBars: 2,
    exitConfirmBars: 2,
    minHoldBars: 13,
    cooldownBars: 6,
};

const expectedBtcDefaultParams: NumericMap = {
    volWindow: 26,
    volLookback: 149,
    fastPeriod: 39,
    slowPeriod: 268,
    useSpikeRegime: 1,
    useRecoveryRegime: 1,
    useLowVolDeRisk: 1,
    useMlOverlay: 1,
    adaptiveLookbacks: 0,
    adaptiveStrengthPct: 0,
    minAdaptiveFactor: 1,
    maxAdaptiveFactor: 1,
    spikePercentilePct: 80,
    calmPercentilePct: 25,
    oversoldRetPct: 3,
    extensionPct: 5,
    mlBullThresholdPct: 60,
    entryExposurePct: 67.3756,
    exitExposurePct: 49.2985,
    entryConfirmBars: 2,
    exitConfirmBars: 2,
    minHoldBars: 9,
    cooldownBars: 6,
};

const expectedSolOverrides: Record<string, string | number> = {
    riskMode: "simple",
    stopLossAtr: 2.5,
    takeProfitAtr: 0,
    trailingAtr: 0,
    timeStopBars: 0,
    tradeFilterMode: "adx",
    adxMin: 20,
    adxMax: 0,
    confirmLookback: 1,
};

const expectedBtcOverrides: Record<string, string | number> = {
    riskMode: "simple",
    stopLossAtr: 1.5,
    takeProfitAtr: 0,
    trailingAtr: 0,
    timeStopBars: 0,
    tradeFilterMode: "adx",
    adxMin: 15,
    adxMax: 0,
    confirmLookback: 1,
};

function main(): void {
    assertExactNumericMap("sol_queen_v1.defaultParams", sol_queen_v1.defaultParams, expectedSolDefaultParams);
    assertExactNumericMap("btc_queen_v1.defaultParams", btc_queen_v1.defaultParams, expectedBtcDefaultParams);
    assertExactLiteralMap(
        "sol_queen_v1_backtest_overrides",
        sol_queen_v1_backtest_overrides as Record<string, unknown>,
        expectedSolOverrides
    );
    assertExactLiteralMap(
        "btc_queen_v1_backtest_overrides",
        btc_queen_v1_backtest_overrides as Record<string, unknown>,
        expectedBtcOverrides
    );
    console.log("[EmpireIntegrity] PASS");
}

main();
