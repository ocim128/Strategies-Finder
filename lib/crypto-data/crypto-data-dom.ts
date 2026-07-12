import { getRequiredElement } from "../dom-utils";

/**
 * Crypto Data tab DOM contract. Mirrors `lib/ibkr-data/ibkr-data-dom.ts`.
 *
 * Structural ids live here (the feature-local `*-dom.ts` module) and are
 * re-exported through `lib/feature-dom-contracts.ts` for the contract test.
 * The HTML source of truth is `html-partials/tab-crypto-data.html`.
 */
export const CRYPTO_DATA_REQUIRED_IDS = [
    "cryptodataTab",
    "cryptoDataDownloadBtn",
    "cryptoDataSyncBtn",
    "cryptoDataStopBtn",
    "cryptoDataCopyBtn",
    "cryptoDataSymbols",
    "cryptoDataLoadSymbolTemplateBtn",
    "cryptoDataInterval",
    "cryptoDataMarketType",
    "cryptoDataStatus",
    "cryptoDataOutput",
] as const;

export function createCryptoDataDom() {
    return {
        cryptodataTab: getRequiredElement("cryptodataTab"),
        cryptoDataDownloadBtn: getRequiredElement<HTMLButtonElement>("cryptoDataDownloadBtn"),
        cryptoDataSyncBtn: getRequiredElement<HTMLButtonElement>("cryptoDataSyncBtn"),
        cryptoDataStopBtn: getRequiredElement<HTMLButtonElement>("cryptoDataStopBtn"),
        cryptoDataCopyBtn: getRequiredElement<HTMLButtonElement>("cryptoDataCopyBtn"),
        cryptoDataSymbols: getRequiredElement<HTMLTextAreaElement>("cryptoDataSymbols"),
        cryptoDataLoadSymbolTemplateBtn: getRequiredElement<HTMLButtonElement>("cryptoDataLoadSymbolTemplateBtn"),
        cryptoDataInterval: getRequiredElement<HTMLSelectElement>("cryptoDataInterval"),
        cryptoDataMarketType: getRequiredElement<HTMLSelectElement>("cryptoDataMarketType"),
        cryptoDataStatus: getRequiredElement<HTMLDivElement>("cryptoDataStatus"),
        cryptoDataOutput: getRequiredElement<HTMLPreElement>("cryptoDataOutput"),
    };
}

export type CryptoDataDom = ReturnType<typeof createCryptoDataDom>;
