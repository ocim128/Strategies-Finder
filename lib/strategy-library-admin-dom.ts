import { getRequiredElement } from "./dom-utils";

export const STRATEGY_LIBRARY_ADMIN_REQUIRED_IDS = [
    "strategyLibraryMenu",
    "strategyLibraryMenuStatus",
    "strategyLibraryBulkKeys",
    "useCurrentStrategyKeyBtn",
    "deleteBuiltInStrategyBtn",
    "deleteBulkBuiltInStrategiesBtn",
] as const;

export function createStrategyLibraryAdminDom() {
    return {
        strategyLibraryMenu: getRequiredElement<HTMLDetailsElement>("strategyLibraryMenu"),
        strategyLibraryMenuStatus: getRequiredElement("strategyLibraryMenuStatus"),
        strategyLibraryBulkKeys: getRequiredElement<HTMLTextAreaElement>("strategyLibraryBulkKeys"),
        useCurrentStrategyKeyBtn: getRequiredElement<HTMLButtonElement>("useCurrentStrategyKeyBtn"),
        deleteBuiltInStrategyBtn: getRequiredElement<HTMLButtonElement>("deleteBuiltInStrategyBtn"),
        deleteBulkBuiltInStrategiesBtn: getRequiredElement<HTMLButtonElement>("deleteBulkBuiltInStrategiesBtn"),
    };
}

export type StrategyLibraryAdminDom = ReturnType<typeof createStrategyLibraryAdminDom>;
