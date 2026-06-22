import { expect } from 'chai';
import { describe, it } from 'node:test';
import {
    EXIT_STRATEGY_PARAM_PREFIX,
    addExitStrategyParamPrefix,
    isExitStrategyParamKey,
    stripExitStrategyParamPrefix,
    withExitStrategyBaseParams,
    splitExitStrategyParams,
} from '../lib/finder/exit-strategy-param-prefix';

describe('Exit Strategy param prefix helpers', () => {
    describe('isExitStrategyParamKey', () => {
        it('returns true for prefixed keys', () => {
            expect(isExitStrategyParamKey(`${EXIT_STRATEGY_PARAM_PREFIX}lookback`)).to.equal(true);
        });

        it('returns false for unprefixed keys', () => {
            expect(isExitStrategyParamKey('lookback')).to.equal(false);
            expect(isExitStrategyParamKey('_exit_lookback')).to.equal(false); // single underscore is not the prefix
        });
    });

    describe('addExitStrategyParamPrefix / stripExitStrategyParamPrefix', () => {
        it('round-trips a key', () => {
            const prefixed = addExitStrategyParamPrefix('lookback');
            expect(prefixed).to.equal(`${EXIT_STRATEGY_PARAM_PREFIX}lookback`);
            expect(stripExitStrategyParamPrefix(prefixed)).to.equal('lookback');
        });
    });

    describe('withExitStrategyBaseParams', () => {
        it('merges exit params under the prefix without colliding with entry param names', () => {
            const result = withExitStrategyBaseParams(
                { lookback: 10, threshold: 0.5 },
                { lookback: 20, multiplier: 2 }
            );
            expect(result).to.deep.equal({
                lookback: 10,
                threshold: 0.5,
                [`${EXIT_STRATEGY_PARAM_PREFIX}lookback`]: 20,
                [`${EXIT_STRATEGY_PARAM_PREFIX}multiplier`]: 2,
            });
        });

        it('returns base params unchanged when exit params are absent', () => {
            const base = { lookback: 10 };
            expect(withExitStrategyBaseParams(base)).to.equal(base);
            expect(withExitStrategyBaseParams(base, {})).to.equal(base);
        });
    });

    describe('splitExitStrategyParams', () => {
        it('separates prefixed exit params from entry params', () => {
            const combined = {
                lookback: 10,
                [`${EXIT_STRATEGY_PARAM_PREFIX}lookback`]: 20,
                threshold: 0.5,
                [`${EXIT_STRATEGY_PARAM_PREFIX}multiplier`]: 2,
            };
            const { entryParams, exitParams } = splitExitStrategyParams(combined);
            expect(entryParams).to.deep.equal({ lookback: 10, threshold: 0.5 });
            expect(exitParams).to.deep.equal({ lookback: 20, multiplier: 2 });
        });

        it('returns all params as entry params when none are prefixed', () => {
            const { entryParams, exitParams } = splitExitStrategyParams({ lookback: 10 });
            expect(entryParams).to.deep.equal({ lookback: 10 });
            expect(exitParams).to.deep.equal({});
        });

        it('handles empty input', () => {
            const { entryParams, exitParams } = splitExitStrategyParams({});
            expect(entryParams).to.deep.equal({});
            expect(exitParams).to.deep.equal({});
        });
    });
});
