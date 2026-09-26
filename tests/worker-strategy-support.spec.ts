import { expect } from 'chai';
import { describe, it } from 'node:test';
import {
    getWorkerSupportedStrategyKeys,
    isWorkerSupportedStrategyKey,
} from '../lib/alert-subscription-utils';
import { strategyManifest } from '../lib/strategies/manifest-eager';

describe('Worker strategy support', () => {
    it('supports every registered built-in without a secondary-data runtime', () => {
        const expected = strategyManifest.map((entry) => entry.key).sort((a, b) => a.localeCompare(b));
        expect(getWorkerSupportedStrategyKeys()).to.deep.equal(expected);
        for (const key of expected) {
            expect(isWorkerSupportedStrategyKey(key), key).to.equal(true);
        }
        expect(isWorkerSupportedStrategyKey('__missing_strategy__')).to.equal(false);
    });
});
