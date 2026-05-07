import type { PolymarketPricePoint } from "./local-sqlite-polymarket-api";
import { getPolymarketSidePrice } from "./polymarket-price-points";

export type PolymarketLimitEntrySide = "yes" | "no";
export type PolymarketLimitEntryPriceMode = "fixed_price" | "signal_offset";
export type PolymarketLimitExitPriceMode = "fixed_price" | "entry_offset";

export type PolymarketLimitEntryStatus =
    | "filled"
    | "not_touched"
    | "last_minute_only"
    | "missing_price_points"
    | "invalid_window";

export type PolymarketLimitExitStatus =
    | "filled"
    | "not_touched"
    | "missing_price_points"
    | "unreachable";

export interface PolymarketPostSignalLimitEntryInput {
    side: PolymarketLimitEntrySide;
    startTs: number;
    eventEndTs: number;
    limitPrice?: number;
    priceMode?: PolymarketLimitEntryPriceMode;
    offsetPrice?: number;
    latestAllowedTs?: number | null;
}

export interface PolymarketPostSignalLimitEntryResult {
    status: PolymarketLimitEntryStatus;
    limitPrice: number | null;
    fillTs: number | null;
    fillPrice: number | null;
    firstAvailablePrice: number | null;
    firstDisallowedTouchTs: number | null;
    entryImprovement: number | null;
}

export interface PolymarketPostSignalLimitEntrySettings {
    enabled: boolean;
    priceCents: number;
    priceMode?: PolymarketLimitEntryPriceMode;
    offsetCents?: number;
    exitEnabled?: boolean;
    exitMode?: PolymarketLimitExitPriceMode;
    exitPriceCents?: number;
    exitOffsetCents?: number;
}

export interface PolymarketPostSignalLimitExitInput {
    side: PolymarketLimitEntrySide;
    startTs: number;
    eventEndTs: number;
    targetPrice: number | null;
}

export interface PolymarketPostSignalLimitExitResult {
    status: PolymarketLimitExitStatus;
    targetPrice: number | null;
    fillTs: number | null;
    fillPrice: number | null;
}

export const DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_ENTRY_ENABLED = false;
export const DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_ENTRY_PRICE_CENTS = 50;
export const DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_ENTRY_MODE: PolymarketLimitEntryPriceMode = "fixed_price";
export const DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_ENTRY_OFFSET_CENTS = 20;
export const DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_EXIT_ENABLED = false;
export const DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_EXIT_MODE: PolymarketLimitExitPriceMode = "entry_offset";
export const DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_EXIT_PRICE_CENTS = 80;
export const DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_EXIT_OFFSET_CENTS = 20;

function parseFiniteNumber(value: unknown): number | null {
    const raw = typeof value === "number"
        ? value
        : typeof value === "string"
            ? value.trim() === ""
                ? Number.NaN
                : Number(value.trim())
            : Number.NaN;

    return Number.isFinite(raw) ? raw : null;
}

function clampPolymarketPostSignalCentValue(value: unknown, fallback: number, min: number): number {
    const raw = parseFiniteNumber(value);
    if (raw === null) {
        return fallback;
    }
    return Math.max(min, Math.min(99, Math.round(raw)));
}

export function clampPolymarketPostSignalLimitEntryPriceCents(value: unknown): number {
    return clampPolymarketPostSignalCentValue(
        value,
        DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_ENTRY_PRICE_CENTS,
        1
    );
}

export function clampPolymarketPostSignalLimitExitPriceCents(value: unknown): number {
    return clampPolymarketPostSignalCentValue(
        value,
        DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_EXIT_PRICE_CENTS,
        1
    );
}

export function clampPolymarketPostSignalLimitOffsetCents(value: unknown): number {
    return clampPolymarketPostSignalCentValue(
        value,
        DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_ENTRY_OFFSET_CENTS,
        0
    );
}

export function resolvePolymarketPostSignalLimitEntryMode(value: unknown): PolymarketLimitEntryPriceMode {
    return typeof value === "string" && value.trim().toLowerCase() === "signal_offset"
        ? "signal_offset"
        : DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_ENTRY_MODE;
}

export function resolvePolymarketPostSignalLimitExitMode(value: unknown): PolymarketLimitExitPriceMode {
    return typeof value === "string" && value.trim().toLowerCase() === "fixed_price"
        ? "fixed_price"
        : DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_EXIT_MODE;
}

function clampLimitPrice(value: number): number {
    const clamped = Math.max(0.01, Math.min(0.99, value));
    return Math.round(clamped * 1_000_000) / 1_000_000;
}

function isFiniteUnixSecond(value: number): boolean {
    return Number.isFinite(value) && value > 0;
}

function createResult(
    status: PolymarketLimitEntryStatus,
    values: Partial<Omit<PolymarketPostSignalLimitEntryResult, "status">> = {}
): PolymarketPostSignalLimitEntryResult {
    return {
        status,
        limitPrice: values.limitPrice ?? null,
        fillTs: values.fillTs ?? null,
        fillPrice: values.fillPrice ?? null,
        firstAvailablePrice: values.firstAvailablePrice ?? null,
        firstDisallowedTouchTs: values.firstDisallowedTouchTs ?? null,
        entryImprovement: values.entryImprovement ?? null,
    };
}

function createExitResult(
    status: PolymarketLimitExitStatus,
    values: Partial<Omit<PolymarketPostSignalLimitExitResult, "status">> = {}
): PolymarketPostSignalLimitExitResult {
    return {
        status,
        targetPrice: values.targetPrice ?? null,
        fillTs: values.fillTs ?? null,
        fillPrice: values.fillPrice ?? null,
    };
}

function resolveEntryLimitPrice(input: PolymarketPostSignalLimitEntryInput, firstAvailablePrice: number): number | null {
    const mode = resolvePolymarketPostSignalLimitEntryMode(input.priceMode);
    if (mode === "signal_offset") {
        const rawOffsetPrice = Number.isFinite(input.offsetPrice) ? Number(input.offsetPrice) : 0;
        return clampLimitPrice(firstAvailablePrice - Math.max(0, rawOffsetPrice));
    }

    return typeof input.limitPrice === "number" && Number.isFinite(input.limitPrice)
        ? input.limitPrice
        : null;
}

export function resolvePolymarketLimitExitTargetPrice(
    entryPrice: number,
    settings: Pick<PolymarketPostSignalLimitEntrySettings, "exitMode" | "exitPriceCents" | "exitOffsetCents">
): number | null {
    if (!Number.isFinite(entryPrice) || entryPrice <= 0 || entryPrice >= 1) {
        return null;
    }
    const mode = resolvePolymarketPostSignalLimitExitMode(settings.exitMode);
    if (mode === "fixed_price") {
        return clampPolymarketPostSignalLimitExitPriceCents(settings.exitPriceCents) / 100;
    }

    const targetPrice = entryPrice + clampPolymarketPostSignalLimitOffsetCents(settings.exitOffsetCents) / 100;
    return targetPrice >= 1 ? null : clampLimitPrice(targetPrice);
}

export function findPostSignalLimitEntryFill(
    eventPoints: readonly PolymarketPricePoint[],
    input: PolymarketPostSignalLimitEntryInput
): PolymarketPostSignalLimitEntryResult {
    const finalMinuteCutoffTs = input.eventEndTs - 60;
    const signalLatestAllowedTs = typeof input.latestAllowedTs === "number" && Number.isFinite(input.latestAllowedTs)
        ? input.latestAllowedTs
        : null;

    if (
        !isFiniteUnixSecond(input.startTs)
        || !isFiniteUnixSecond(input.eventEndTs)
        || input.startTs >= finalMinuteCutoffTs
        || (signalLatestAllowedTs !== null && input.startTs > signalLatestAllowedTs)
    ) {
        return createResult("invalid_window");
    }

    const fixedLimitPrice = resolvePolymarketPostSignalLimitEntryMode(input.priceMode) === "fixed_price"
        ? resolveEntryLimitPrice(input, 0.5)
        : null;
    if (resolvePolymarketPostSignalLimitEntryMode(input.priceMode) === "fixed_price" && (
        fixedLimitPrice === null
        || fixedLimitPrice <= 0
        || fixedLimitPrice >= 1
    )) {
        return createResult("invalid_window");
    }

    let firstAvailablePrice: number | null = null;
    let limitPrice: number | null = fixedLimitPrice;
    let firstDisallowedTouchTs: number | null = null;

    for (const point of eventPoints) {
        if (point.ts < input.startTs) {
            continue;
        }
        if (point.ts >= input.eventEndTs) {
            break;
        }

        const price = getPolymarketSidePrice(point, input.side);
        if (price === null) {
            continue;
        }

        if (firstAvailablePrice === null) {
            firstAvailablePrice = price;
            limitPrice = resolveEntryLimitPrice(input, firstAvailablePrice);
            if (limitPrice === null || limitPrice <= 0 || limitPrice >= 1) {
                return createResult("invalid_window", { firstAvailablePrice });
            }
        }

        if (limitPrice === null || price > limitPrice) {
            continue;
        }

        const isAfterFinalMinuteCutoff = point.ts >= finalMinuteCutoffTs;
        const isAfterSignalExitCutoff = signalLatestAllowedTs !== null && point.ts > signalLatestAllowedTs;
        if (isAfterFinalMinuteCutoff || isAfterSignalExitCutoff) {
            firstDisallowedTouchTs = point.ts;
            break;
        }

        const entryImprovement = firstAvailablePrice === null
            ? null
            : Math.max(0, firstAvailablePrice - limitPrice);
        return createResult("filled", {
            limitPrice,
            fillTs: point.ts,
            fillPrice: limitPrice,
            firstAvailablePrice,
            entryImprovement,
        });
    }

    if (firstAvailablePrice === null) {
        return createResult("missing_price_points");
    }

    if (firstDisallowedTouchTs !== null) {
        const status = signalLatestAllowedTs !== null
            && firstDisallowedTouchTs > signalLatestAllowedTs
            && signalLatestAllowedTs < finalMinuteCutoffTs
            ? "invalid_window"
            : "last_minute_only";
        return createResult(status, {
            limitPrice,
            firstAvailablePrice,
            firstDisallowedTouchTs,
        });
    }

    return createResult("not_touched", {
        limitPrice,
        firstAvailablePrice,
    });
}

export function findPostSignalLimitExitFill(
    eventPoints: readonly PolymarketPricePoint[],
    input: PolymarketPostSignalLimitExitInput
): PolymarketPostSignalLimitExitResult {
    if (
        !isFiniteUnixSecond(input.startTs)
        || !isFiniteUnixSecond(input.eventEndTs)
        || input.startTs >= input.eventEndTs
    ) {
        return createExitResult("missing_price_points", { targetPrice: input.targetPrice });
    }
    if (input.targetPrice === null || !Number.isFinite(input.targetPrice) || input.targetPrice <= 0 || input.targetPrice >= 1) {
        return createExitResult("unreachable");
    }

    let hasAvailablePrice = false;
    for (const point of eventPoints) {
        if (point.ts < input.startTs) {
            continue;
        }
        if (point.ts >= input.eventEndTs) {
            break;
        }

        const price = getPolymarketSidePrice(point, input.side);
        if (price === null) {
            continue;
        }
        hasAvailablePrice = true;
        if (price >= input.targetPrice) {
            return createExitResult("filled", {
                targetPrice: input.targetPrice,
                fillTs: point.ts,
                fillPrice: input.targetPrice,
            });
        }
    }

    return createExitResult(hasAvailablePrice ? "not_touched" : "missing_price_points", {
        targetPrice: input.targetPrice,
    });
}
