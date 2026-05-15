import { expect } from "chai";
import { beforeEach, describe, it } from "node:test";
import { collectStrategyModuleDefinitions, generateStrategyManifestEagerSource } from "../scripts/strategy-manifest-generator";
import {
    ensureStrategyKeysLoaded,
    getBuiltInMeta,
    getStrategyList,
    isBuiltInStrategyKey,
    loadBuiltInStrategies,
    strategyRegistry,
} from "../strategyRegistry";
import { ensureConfirmationStrategiesLoaded } from "../lib/confirmation-signal-filter";
import { getLoadedBuiltInStrategy } from "../lib/strategies/built-in-catalog";
import { DEFAULT_BUILT_IN_STRATEGY_KEY } from "../lib/strategy-defaults";

function getNonDefaultBuiltInStrategyKey(): string {
    const definitions = collectStrategyModuleDefinitions();
    const alternate = definitions.find((definition) => definition.key !== DEFAULT_BUILT_IN_STRATEGY_KEY);
    if (!alternate) {
        throw new Error("Expected at least one non-default built-in strategy");
    }
    return alternate.key;
}

describe("Strategy registry loading", () => {
    beforeEach(async () => {
        strategyRegistry.clear();
        await loadBuiltInStrategies([DEFAULT_BUILT_IN_STRATEGY_KEY]);
    });

    it("collects at least one strategy module definition", () => {
        const definitions = collectStrategyModuleDefinitions();
        expect(definitions.length).to.be.greaterThan(0);
    });

    it("every strategy key is lowercase with underscores", () => {
        const definitions = collectStrategyModuleDefinitions();
        for (const def of definitions) {
            expect(def.key).to.match(/^[a-z][a-z0-9_]*$/, `key "${def.key}" is not valid`);
        }
    });

    it("every strategy has a unique key", () => {
        const definitions = collectStrategyModuleDefinitions();
        const keys = definitions.map(d => d.key);
        const uniqueKeys = new Set(keys);
        expect(uniqueKeys.size).to.equal(keys.length);
    });

    it("generated manifest has valid import paths", () => {
        const definitions = collectStrategyModuleDefinitions();
        for (const def of definitions) {
            expect(def.importPath).to.match(/^\.\/lib\//, `import path "${def.importPath}" is not valid`);
            expect(def.importPath).to.not.match(/\.ts$/, `import path "${def.importPath}" should not end in .ts`);
        }
    });

    it("generated eager manifest source contains all strategy entries", () => {
        const definitions = collectStrategyModuleDefinitions();
        const source = generateStrategyManifestEagerSource(definitions);
        for (const def of definitions) {
            expect(source).to.include(`key: "${def.key}"`);
            expect(source).to.include(`strategy: ${def.exportName}`);
        }
    });

    it("keeps unloaded built-ins discoverable by metadata after boot", () => {
        const alternateKey = getNonDefaultBuiltInStrategyKey();

        expect(strategyRegistry.has(DEFAULT_BUILT_IN_STRATEGY_KEY)).to.equal(true);
        expect(strategyRegistry.has(alternateKey)).to.equal(false);
        expect(isBuiltInStrategyKey(alternateKey)).to.equal(true);

        const meta = getBuiltInMeta(alternateKey);
        expect(meta, `missing built-in metadata for ${alternateKey}`).to.exist;

        const listEntry = getStrategyList().find((entry) => entry.key === alternateKey);
        expect(listEntry).to.deep.equal({
            key: alternateKey,
            name: meta!.name,
            description: meta!.description,
        });
    });

    it("preloads confirmation strategies for synchronous signal filters", async () => {
        const confirmationKey = "close_location_median_alignment";

        await ensureConfirmationStrategiesLoaded({ confirmationStrategies: [confirmationKey] });

        expect(getLoadedBuiltInStrategy(confirmationKey)).to.exist;
    });

    it("can lazily load a valid built-in strategy key after boot", async () => {
        const alternateKey = getNonDefaultBuiltInStrategyKey();

        expect(strategyRegistry.has(alternateKey)).to.equal(false);

        await ensureStrategyKeysLoaded([alternateKey]);

        const strategy = strategyRegistry.get(alternateKey);
        expect(strategyRegistry.has(alternateKey)).to.equal(true);
        expect(strategy, `expected strategy ${alternateKey} to be registered`).to.exist;
        expect(strategy?.name).to.equal(getBuiltInMeta(alternateKey)?.name);
    });

    it("re-registers a cached built-in after the registry is cleared", async () => {
        expect(strategyRegistry.has(DEFAULT_BUILT_IN_STRATEGY_KEY)).to.equal(true);

        strategyRegistry.clear();
        expect(strategyRegistry.has(DEFAULT_BUILT_IN_STRATEGY_KEY)).to.equal(false);

        await loadBuiltInStrategies([DEFAULT_BUILT_IN_STRATEGY_KEY]);

        expect(strategyRegistry.has(DEFAULT_BUILT_IN_STRATEGY_KEY)).to.equal(true);
        expect(strategyRegistry.get(DEFAULT_BUILT_IN_STRATEGY_KEY)?.name).to.equal(
            getBuiltInMeta(DEFAULT_BUILT_IN_STRATEGY_KEY)?.name
        );
    });
});
