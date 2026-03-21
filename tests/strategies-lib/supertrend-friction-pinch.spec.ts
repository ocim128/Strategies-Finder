import { expect } from 'chai';
import { describe, it } from 'node:test';
import { supertrend_friction_pinch } from '../lib/strategies/lib/supertrend_friction_pinch';
import type { OHLCVData } from '../lib/strategies';

describe('supertrend_friction_pinch', () => {
    it('removes fixed supertrend controls from the live param contract', () => {
        expect(Object.keys(supertrend_friction_pinch.defaultParams)).to.deep.equal([
            'rocTarget',
        ]);
        expect(Object.keys(supertrend_friction_pinch.paramLabels)).to.deep.equal([
            'rocTarget',
        ]);
        expect(supertrend_friction_pinch.metadata?.walkForwardParams).to.deep.equal([
            'rocTarget',
        ]);
    });

    it('forces legacy stPeriod and pinchLookback inputs to one', () => {
        const normalized = supertrend_friction_pinch.normalizeParams!({
            stPeriod: 99,
            pinchLookback: 42,
            rocTarget: -2.5,
        });

        expect(normalized.stPeriod).to.equal(1);
        expect(normalized.pinchLookback).to.equal(1);
        expect(normalized.rocTarget).to.equal(-2.5);
    });

    it('ignores legacy stPeriod and pinchLookback values during execution', () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 20; i++) {
            const base = 100 + i;
            data.push({
                time: i + 1,
                open: base,
                high: base + 1,
                low: base - 1,
                close: base + 0.25,
                volume: 1_000,
            });
        }

        const baseSignals = supertrend_friction_pinch.execute(data, {
            rocTarget: -0.5,
        });
        const legacySignals = supertrend_friction_pinch.execute(data, {
            stPeriod: 10,
            pinchLookback: 20,
            rocTarget: -0.5,
        });

        expect(legacySignals).to.deep.equal(baseSignals);
    });
});
