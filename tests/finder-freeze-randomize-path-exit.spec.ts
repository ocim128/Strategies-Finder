import { expect } from 'chai';
import { describe, it } from 'node:test';
import type { BacktestSettings, Strategy } from '../lib/types/strategies';
import {
    buildFinderSearchBaseParams,
    mergeFinderRiskParamsIntoBacktestSettings,
    resolveFinderRiskOverrides,
} from '../lib/finder/finder-runner-core';

/**
 * Intent: when "Keep current risk settings fixed" (freezeRiskManagement) is on,
 * Finder must still vary Path-Exit controls when "Randomize Path Exits" is also
 * on. The two toggles used to be mutually exclusive, which made Randomize Path
 * Exits silently dead whenever users locked down their ATR/SL/TP risk controls.
 *
 * WHY this matters:
 *  - Randomize Path Exits is the only research surface for path-dependent exits;
 *    gating it on freeze being off made it unreachable in the exact workflow
 *    (locked risk + explore exits) it was built for.
 *  - The freeze guarantee — ATR/SL/TP/maxHold untouched — must remain intact
 *    when randomize is layered on top, or users lose trust in Apply.
 */

const PATH_EXIT_SETTINGS: BacktestSettings = {
    riskMode: 'simple',
    pathExitEnabled: true,
    pathExitMode: 'profit_compression',
    pathExitMinBars: 8,
    pathExitThreshold: 0.5,
    pathExitMinMfePercent: 1.5,
    // ATR / SL / TP / maxHold controls that freeze must protect:
    atrPeriod: 14,
    stopLossEnabled: true,
    stopLossPercent: 3,
    takeProfitEnabled: true,
    takeProfitPercent: 7,
    riskMaxHoldEnabled: true,
    riskMaxHoldBars: 6,
};

const STRATEGY = { defaultParams: { lookback: 20 } } as unknown as Strategy;

describe('Finder freeze + Randomize Path Exits interplay', () => {
    describe('buildFinderSearchBaseParams', () => {
        it('still searches path-exit params under freeze when randomize is on', () => {
            // WHY: freeze must not blank the path-exit search space — otherwise
            // Finder has nothing to vary and the randomize toggle is dead.
            const baseParams = buildFinderSearchBaseParams(STRATEGY, PATH_EXIT_SETTINGS, {
                freezeRiskManagement: true,
                randomizePathExitParams: true,
            });

            // profit_compression mode adds pathExitMinBars, pathExitMinMfePercent,
            // and pathExitThreshold to the search space.
            expect(baseParams.pathExitMinBars).to.equal(8);
            expect(baseParams.pathExitMinMfePercent).to.equal(1.5);
            expect(baseParams.pathExitThreshold).to.equal(0.5);

            // Frozen ATR/SL/TP/maxHold controls are NOT added to the search space.
            expect(baseParams.atrPeriod).to.equal(undefined);
            expect(baseParams.stopLossPercent).to.equal(undefined);
            expect(baseParams.takeProfitPercent).to.equal(undefined);
            expect(baseParams.riskMaxHoldBars).to.equal(undefined);
        });

        it('still freezes everything (including path-exit) when randomize is off', () => {
            // WHY: regresssion guard — the un-freeze-of-path-exits must only
            // trigger when the user actually asked for it.
            const baseParams = buildFinderSearchBaseParams(STRATEGY, PATH_EXIT_SETTINGS, {
                freezeRiskManagement: true,
                randomizePathExitParams: false,
            });

            expect(baseParams).to.deep.equal({ lookback: 20 });
        });
    });

    describe('resolveFinderRiskOverrides', () => {
        it('applies path-exit overrides under freeze but leaves frozen keys and Rust settings untouched', () => {
            // WHY: per-candidate, the candidate's path-exit param picks must
            // reach the backtest engine even when risk is frozen — but Rust
            // (which can't run path exits anyway) and the frozen ATR/SL/TP
            // keys must remain exactly as the user set them.
            const rustSettings: BacktestSettings = { ...PATH_EXIT_SETTINGS, atrPeriod: 99 };
            const { backtestSettings, rustBacktestSettings } = resolveFinderRiskOverrides(
                PATH_EXIT_SETTINGS,
                rustSettings,
                { pathExitThreshold: 0.9, pathExitMinBars: 12, atrPeriod: 50, stopLossPercent: 20 },
                { freezeRiskManagement: true, randomizePathExitParams: true },
            );

            // Path-exit overrides apply to the backtest side.
            expect(backtestSettings.pathExitThreshold).to.equal(0.9);
            expect(backtestSettings.pathExitMinBars).to.equal(12);

            // Frozen ATR/SL/TP/maxHold are preserved on the backtest side.
            expect(backtestSettings.atrPeriod).to.equal(14);
            expect(backtestSettings.stopLossPercent).to.equal(3);
            expect(backtestSettings.takeProfitPercent).to.equal(7);
            expect(backtestSettings.riskMaxHoldBars).to.equal(6);

            // Rust side is untouched (path exits force TS engine; Rust never
            // sees these overrides, and the frozen ATR must not bleed into it).
            expect(rustBacktestSettings.atrPeriod).to.equal(99);
            expect(rustBacktestSettings.pathExitThreshold).to.equal(0.5);
        });

        it('returns settings unchanged under freeze when randomize is off', () => {
            const { backtestSettings, rustBacktestSettings } = resolveFinderRiskOverrides(
                PATH_EXIT_SETTINGS,
                { ...PATH_EXIT_SETTINGS, atrPeriod: 99 },
                { pathExitThreshold: 0.9, atrPeriod: 50 },
                { freezeRiskManagement: true, randomizePathExitParams: false },
            );

            expect(backtestSettings).to.deep.equal(PATH_EXIT_SETTINGS);
            expect(rustBacktestSettings.atrPeriod).to.equal(99);
        });
    });

    describe('mergeFinderRiskParamsIntoBacktestSettings (Apply result)', () => {
        it('writes path-exit params on Apply under freeze but preserves frozen keys', () => {
            // WHY: Apply is the user-facing payoff. If it skips path-exit params
            // under freeze, the winning candidate's path-exit configuration is
            // silently discarded the moment the user clicks Apply.
            const merged = mergeFinderRiskParamsIntoBacktestSettings(
                { ...PATH_EXIT_SETTINGS, riskSettingsToggle: true },
                { pathExitThreshold: 0.9, pathExitMinBars: 12, atrPeriod: 50, stopLossPercent: 20 },
                { freezeRiskManagement: true, randomizePathExitParams: true },
            );

            // Path-exit params are written.
            expect(merged.pathExitThreshold).to.equal(0.9);
            expect(merged.pathExitMinBars).to.equal(12);

            // Frozen keys are preserved.
            expect(merged.atrPeriod).to.equal(14);
            expect(merged.stopLossPercent).to.equal(3);
            expect(merged.takeProfitPercent).to.equal(7);
            expect(merged.riskMaxHoldBars).to.equal(6);
        });

        it('preserves everything on Apply under freeze when randomize is off', () => {
            const merged = mergeFinderRiskParamsIntoBacktestSettings(
                { ...PATH_EXIT_SETTINGS, riskSettingsToggle: true },
                { pathExitThreshold: 0.9, atrPeriod: 50 },
                { freezeRiskManagement: true, randomizePathExitParams: false },
            );

            expect(merged.pathExitThreshold).to.equal(0.5);
            expect(merged.atrPeriod).to.equal(14);
        });
    });
});
