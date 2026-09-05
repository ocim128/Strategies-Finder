/**
 * Pure price-prefix feature construction for the TOP_MEAN successor work.
 *
 * This module intentionally has no filesystem, archive, or outcome imports.
 * The builder converts 30m bars to the compact session summaries consumed here.
 */

export const TOP_MEAN_PRICE_FEATURES_SCHEMA = "top_mean_price_features.v1" as const;
export const TOP_MEAN_PRICE_FEATURE_CONTRACT_VERSION = "top_mean_price_feature_set.v1" as const;
export const TOP_MEAN_PRICE_FEATURE_FORMULA_VERSION = "tm_price_feature_formulas.v1" as const;
export const TOP_MEAN_PRICE_FEATURE_AVAILABILITY_POLICY = "strict_prior_session_close_v1" as const;
export const TOP_MEAN_PRICE_SESSION_SCHEDULE_VERSION = "nyse_regular_v1" as const;
export const TOP_MEAN_PRICE_MIN_CATALOG_PEERS = 100;

export const TOP_MEAN_PRICE_FEATURE_FIELDS = [
    "priceResidualMomentum5",
    "priceReversalRate5",
    "priceVolExpansion5",
    "priceRelativeVolume1",
    "priceGapFollowThrough20",
    "priceCatalogCorrelation20",
] as const;

export type TopMeanPriceFeatureField = typeof TOP_MEAN_PRICE_FEATURE_FIELDS[number];

export interface TopMeanPriceBar {
    /** Unix seconds at the start of the 30m bar. */
    timeSec: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number | null;
}

export interface TopMeanRegularSessionSchedule {
    date: string;
    openSec: number;
    closeSec: number;
    slotStartSec: readonly number[];
}

export interface TopMeanPriceSessionSummary {
    date: string;
    openSec: number;
    closeSec: number;
    expectedSlotCount: number;
    open: number | null;
    close: number | null;
    slotCloses: readonly number[];
    slotVolumes: readonly (number | null)[];
    complete: boolean;
    maxBarEndSec: number | null;
}

export interface TopMeanCatalogReturnPoint {
    mean: number | null;
    peerCount: number;
}

export type TopMeanCatalogReturns = ReadonlyMap<string, ReadonlyMap<string, TopMeanCatalogReturnPoint>>;

export interface TopMeanPriceFeatureRow {
    eventId: string;
    decisionTimeSec: number;
    asset: string;
    priceResidualMomentum5: number | null;
    priceReversalRate5: number | null;
    priceVolExpansion5: number | null;
    priceRelativeVolume1: number | null;
    priceGapFollowThrough20: number | null;
    priceCatalogCorrelation20: number | null;
}

export type TopMeanPriceFeatureValues = Omit<TopMeanPriceFeatureRow, "eventId" | "decisionTimeSec" | "asset">;

export interface TopMeanPriceFeatureInput {
    asset: string;
    eventId?: string;
    decisionTimeSec: number;
    schedules: readonly TopMeanRegularSessionSchedule[];
    sessions: ReadonlyMap<string, TopMeanPriceSessionSummary>;
    catalogReturns: ReadonlyMap<string, TopMeanCatalogReturnPoint>;
}

export interface TopMeanPriceFeatureDetails extends TopMeanPriceFeatureValues {
    reasons: Readonly<Record<TopMeanPriceFeatureField, string>>;
    maxSourceBarEndSec: Readonly<Record<TopMeanPriceFeatureField, number | null>>;
}

function finite(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function positive(value: unknown): value is number {
    return finite(value) && value > 0;
}

function dateKey(date: Date): string {
    return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
    const value = new Date(`${date}T12:00:00.000Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return dateKey(value);
}

function weekday(date: string): number {
    return new Date(`${date}T12:00:00.000Z`).getUTCDay();
}

function nthWeekday(year: number, month: number, dayOfWeek: number, occurrence: number): string {
    const first = new Date(Date.UTC(year, month - 1, 1, 12));
    const offset = (dayOfWeek - first.getUTCDay() + 7) % 7;
    first.setUTCDate(1 + offset + (occurrence - 1) * 7);
    return dateKey(first);
}

function lastWeekday(year: number, month: number, dayOfWeek: number): string {
    const last = new Date(Date.UTC(year, month, 0, 12));
    last.setUTCDate(last.getUTCDate() - ((last.getUTCDay() - dayOfWeek + 7) % 7));
    return dateKey(last);
}

function observedFixedHoliday(year: number, month: number, day: number): string {
    const date = new Date(Date.UTC(year, month - 1, day, 12));
    if (date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() - 1);
    else if (date.getUTCDay() === 0) date.setUTCDate(date.getUTCDate() + 1);
    return dateKey(date);
}

function easterSunday(year: number): string {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return dateKey(new Date(Date.UTC(year, month - 1, day, 12)));
}

function holidaysForYear(year: number): ReadonlySet<string> {
    const holidays = new Set<string>([
        observedFixedHoliday(year, 1, 1),
        nthWeekday(year, 1, 1, 3),
        nthWeekday(year, 2, 1, 3),
        addDays(easterSunday(year), -2),
        lastWeekday(year, 5, 1),
        observedFixedHoliday(year, 7, 4),
        nthWeekday(year, 9, 1, 1),
        nthWeekday(year, 11, 4, 4),
        observedFixedHoliday(year, 12, 25),
    ]);
    // NYSE adopted Juneteenth as a market holiday in 2022.
    if (year >= 2022) holidays.add(observedFixedHoliday(year, 6, 19));
    return holidays;
}

function timeZoneOffsetSeconds(date: string): number {
    const utc = Date.parse(`${date}T12:00:00.000Z`);
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    }).formatToParts(new Date(utc));
    const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    const localAsUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second));
    return Math.round((localAsUtc - utc) / 1000);
}

function earlyCloseDate(year: number, month: number, day: number): string {
    const candidate = `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
    let result = addDays(candidate, -1);
    while (weekday(result) === 0 || weekday(result) === 6) result = addDays(result, -1);
    return result;
}

function earlyCloseDates(year: number): ReadonlySet<string> {
    const dates = new Set<string>();
    const independence = observedFixedHoliday(year, 7, 4);
    dates.add(earlyCloseDate(Number(independence.slice(0, 4)), Number(independence.slice(5, 7)), Number(independence.slice(8, 10))));
    dates.add(addDays(nthWeekday(year, 11, 4, 4), 1));
    const christmasObserved = observedFixedHoliday(year, 12, 25);
    dates.add(earlyCloseDate(Number(christmasObserved.slice(0, 4)), Number(christmasObserved.slice(5, 7)), Number(christmasObserved.slice(8, 10))));
    // A Saturday/Sunday Christmas has an observed closure on Friday/Monday;
    // the preceding regular Friday is the customary early close when present.
    if (christmasObserved !== `${year}-12-25`) dates.add(earlyCloseDate(Number(christmasObserved.slice(0, 4)), Number(christmasObserved.slice(5, 7)), Number(christmasObserved.slice(8, 10))));
    return dates;
}

/** Frozen NYSE regular-session schedule used by the price enrichment. */
export function buildTopMeanRegularSessionSchedule(fromDate: string, toDate: string): TopMeanRegularSessionSchedule[] {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate) || fromDate > toDate) return [];
    const schedules: TopMeanRegularSessionSchedule[] = [];
    for (let date = fromDate; date <= toDate; date = addDays(date, 1)) {
        const year = Number(date.slice(0, 4));
        const day = weekday(date);
        if (day === 0 || day === 6 || holidaysForYear(year).has(date)) continue;
        const offset = timeZoneOffsetSeconds(date);
        const localOpen = Date.parse(`${date}T09:30:00.000Z`) / 1000;
        const localCloseHour = earlyCloseDates(year).has(date) ? 13 : 16;
        const localClose = Date.parse(`${date}T${localCloseHour.toString().padStart(2, "0")}:00:00.000Z`) / 1000;
        const openSec = localOpen - offset;
        const closeSec = localClose - offset;
        const slotStartSec: number[] = [];
        for (let time = openSec; time < closeSec; time += 1800) slotStartSec.push(time);
        schedules.push({ date, openSec, closeSec, slotStartSec });
    }
    return schedules;
}

/** Build a compact summary from bars already assigned to one scheduled session. */
export function summarizeTopMeanPriceSession(
    schedule: TopMeanRegularSessionSchedule,
    bars: readonly TopMeanPriceBar[],
): TopMeanPriceSessionSummary {
    const byTime = new Map(bars.map((bar) => [bar.timeSec, bar] as const));
    const selected = schedule.slotStartSec.map((timeSec) => byTime.get(timeSec));
    const complete = selected.every((bar) => bar !== undefined && positive(bar.open) && positive(bar.close));
    const validBars = selected.filter((bar): bar is TopMeanPriceBar => bar !== undefined);
    return {
        date: schedule.date,
        openSec: schedule.openSec,
        closeSec: schedule.closeSec,
        expectedSlotCount: schedule.slotStartSec.length,
        open: complete && selected[0] ? selected[0].open : null,
        close: complete && selected[selected.length - 1] ? selected[selected.length - 1]!.close : null,
        slotCloses: complete ? selected.map((bar) => bar!.close) : [],
        slotVolumes: complete ? selected.map((bar) => bar!.volume) : [],
        complete,
        maxBarEndSec: validBars.length > 0 ? Math.max(...validBars.map((bar) => bar.timeSec + 1800)) : null,
    };
}

function completeSession(
    schedules: readonly TopMeanRegularSessionSchedule[],
    sessions: ReadonlyMap<string, TopMeanPriceSessionSummary>,
    index: number,
): TopMeanPriceSessionSummary | null {
    const schedule = schedules[index];
    if (!schedule) return null;
    const session = sessions.get(schedule.date);
    return session?.complete && session.slotCloses.length === schedule.slotStartSec.length ? session : null;
}

function latestCompleteIndex(
    schedules: readonly TopMeanRegularSessionSchedule[],
    sessions: ReadonlyMap<string, TopMeanPriceSessionSummary>,
    decisionTimeSec: number,
): number {
    let low = 0;
    let high = schedules.length - 1;
    let latestBefore = -1;
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (schedules[middle]!.closeSec < decisionTimeSec) {
            latestBefore = middle;
            low = middle + 1;
        } else high = middle - 1;
    }
    for (let index = latestBefore; index >= 0; index -= 1) {
        if (completeSession(schedules, sessions, index)) return index;
    }
    return -1;
}

function requiredSessions(
    schedules: readonly TopMeanRegularSessionSchedule[],
    sessions: ReadonlyMap<string, TopMeanPriceSessionSummary>,
    start: number,
    end: number,
): TopMeanPriceSessionSummary[] | null {
    if (start < 0 || end >= schedules.length || start > end) return null;
    const output: TopMeanPriceSessionSummary[] = [];
    for (let index = start; index <= end; index += 1) {
        const session = completeSession(schedules, sessions, index);
        if (!session) return null;
        output.push(session);
    }
    return output;
}

function closeReturn(current: TopMeanPriceSessionSummary, previous: TopMeanPriceSessionSummary): number | null {
    return positive(current.close) && positive(previous.close) ? Math.log(current.close / previous.close) : null;
}

function sessionReturn(
    schedules: readonly TopMeanRegularSessionSchedule[],
    sessions: ReadonlyMap<string, TopMeanPriceSessionSummary>,
    index: number,
): number | null {
    const current = completeSession(schedules, sessions, index);
    const previous = completeSession(schedules, sessions, index - 1);
    return current && previous ? closeReturn(current, previous) : null;
}

function rangeSourceEnd(sessions: readonly TopMeanPriceSessionSummary[] | null): number | null {
    if (!sessions || sessions.length === 0) return null;
    const values = sessions.map((session) => session.maxBarEndSec).filter(finite);
    return values.length > 0 ? Math.max(...values) : null;
}

function residualMomentum(
    schedules: readonly TopMeanRegularSessionSchedule[],
    sessions: ReadonlyMap<string, TopMeanPriceSessionSummary>,
    catalogReturns: ReadonlyMap<string, TopMeanCatalogReturnPoint>,
    d: number,
): number | null {
    // d-65..d supplies 66 closing prices, hence 65 returns.
    const all = requiredSessions(schedules, sessions, d - 65, d);
    if (!all) return null;
    const fitX: number[] = [];
    const fitY: number[] = [];
    const recentY: number[] = [];
    for (let index = d - 64; index <= d; index += 1) {
        const y = sessionReturn(schedules, sessions, index);
        const catalog = catalogReturns.get(schedules[index]!.date);
        if (y === null || !catalog || catalog.mean === null || catalog.peerCount < TOP_MEAN_PRICE_MIN_CATALOG_PEERS) return null;
        if (index <= d - 5) {
            fitX.push(catalog.mean);
            fitY.push(y);
        } else recentY.push(y);
    }
    const meanX = fitX.reduce((sum, value) => sum + value, 0) / fitX.length;
    const meanY = fitY.reduce((sum, value) => sum + value, 0) / fitY.length;
    let xx = 0;
    let xy = 0;
    for (let index = 0; index < fitX.length; index += 1) {
        xx += (fitX[index]! - meanX) ** 2;
        xy += (fitX[index]! - meanX) * (fitY[index]! - meanY);
    }
    if (xx === 0) return null;
    const beta = xy / xx;
    const alpha = meanY - beta * meanX;
    let sse = 0;
    for (let index = 0; index < fitX.length; index += 1) {
        const residual = fitY[index]! - (alpha + beta * fitX[index]!);
        sse += residual ** 2;
    }
    const sigma = Math.sqrt(sse / 58);
    if (!finite(sigma) || sigma === 0) return null;
    let sum = 0;
    for (let index = d - 4; index <= d; index += 1) {
        const catalog = catalogReturns.get(schedules[index]!.date)!;
        const y = recentY[index - (d - 4)]!;
        sum += y - (alpha + beta * catalog.mean!);
    }
    return sum / (Math.sqrt(5) * sigma);
}

function reversalRate(
    schedules: readonly TopMeanRegularSessionSchedule[],
    sessions: ReadonlyMap<string, TopMeanPriceSessionSummary>,
    d: number,
): number | null {
    const window = requiredSessions(schedules, sessions, d - 4, d);
    if (!window) return null;
    let numerator = 0;
    let denominator = 0;
    for (const session of window) {
        if (!positive(session.open) || session.slotCloses.length === 0) return null;
        let previous: number | null = null;
        for (let index = 0; index < session.slotCloses.length; index += 1) {
            const close = session.slotCloses[index]!;
            const base = index === 0 ? session.open : session.slotCloses[index - 1];
            const value = positive(base) && positive(close) ? Math.log(close / base) : null;
            if (value === null || value === 0) {
                previous = null;
                continue;
            }
            if (previous !== null) {
                denominator += 1;
                if (Math.sign(previous) !== Math.sign(value)) numerator += 1;
            }
            previous = value;
        }
    }
    return denominator > 0 ? numerator / denominator : null;
}

function varianceExpansion(
    schedules: readonly TopMeanRegularSessionSchedule[],
    sessions: ReadonlyMap<string, TopMeanPriceSessionSummary>,
    d: number,
): number | null {
    const window = requiredSessions(schedules, sessions, d - 25, d);
    if (!window) return null;
    const q: number[] = [];
    for (let index = d - 24; index <= d; index += 1) {
        const session = completeSession(schedules, sessions, index)!;
        const gap = closeReturn(session, completeSession(schedules, sessions, index - 1)!);
        if (gap === null || !positive(session.open)) return null;
        let total = gap ** 2;
        let previous = session.open;
        for (const close of session.slotCloses) {
            if (!positive(previous) || !positive(close)) return null;
            const value = Math.log(close / previous);
            total += value ** 2;
            previous = close;
        }
        q.push(total);
    }
    const recent = q.slice(-5).reduce((sum, value) => sum + value, 0) / 5;
    const prior = q.slice(0, 20).reduce((sum, value) => sum + value, 0) / 20;
    return recent > 0 && prior > 0 ? 0.5 * Math.log(recent / prior) : null;
}

function relativeVolume(
    schedules: readonly TopMeanRegularSessionSchedule[],
    sessions: ReadonlyMap<string, TopMeanPriceSessionSummary>,
    d: number,
): number | null {
    const current = completeSession(schedules, sessions, d);
    if (!current) return null;
    const prior = requiredSessions(schedules, sessions, d - 20, d - 1);
    if (!prior) return null;
    const currentVolumes = current.slotVolumes;
    const medians: number[] = [];
    for (let slot = 0; slot < current.expectedSlotCount; slot += 1) {
        const values = prior.map((session) => session.slotVolumes[slot]).filter(finite);
        if (values.length !== 20 || !finite(currentVolumes[slot])) return null;
        values.sort((left, right) => left - right);
        medians.push((values[9]! + values[10]!) / 2);
    }
    const currentTotal = currentVolumes.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    const medianTotal = medians.reduce((sum, value) => sum + value, 0);
    return medianTotal > 0 && currentTotal > 0 ? Math.log(currentTotal / medianTotal) : null;
}

function gapFollowThrough(
    schedules: readonly TopMeanRegularSessionSchedule[],
    sessions: ReadonlyMap<string, TopMeanPriceSessionSummary>,
    d: number,
): number | null {
    const window = requiredSessions(schedules, sessions, d - 20, d);
    if (!window) return null;
    let numerator = 0;
    let gapSquares = 0;
    let intradaySquares = 0;
    for (let index = d - 19; index <= d; index += 1) {
        const session = completeSession(schedules, sessions, index)!;
        const previous = completeSession(schedules, sessions, index - 1)!;
        const gap = closeReturn(session, previous);
        if (gap === null || !positive(session.open) || !positive(session.close)) return null;
        const intraday = Math.log(session.close / session.open);
        numerator += gap * intraday;
        gapSquares += gap ** 2;
        intradaySquares += intraday ** 2;
    }
    const denominator = Math.sqrt(gapSquares * intradaySquares);
    return denominator > 0 ? numerator / denominator : null;
}

function catalogCorrelation(
    schedules: readonly TopMeanRegularSessionSchedule[],
    sessions: ReadonlyMap<string, TopMeanPriceSessionSummary>,
    catalogReturns: ReadonlyMap<string, TopMeanCatalogReturnPoint>,
    d: number,
): number | null {
    const window = requiredSessions(schedules, sessions, d - 20, d);
    if (!window) return null;
    const left: number[] = [];
    const right: number[] = [];
    for (let index = d - 19; index <= d; index += 1) {
        const stock = sessionReturn(schedules, sessions, index);
        const market = catalogReturns.get(schedules[index]!.date);
        if (stock === null || !market || market.mean === null || market.peerCount < TOP_MEAN_PRICE_MIN_CATALOG_PEERS) return null;
        left.push(stock);
        right.push(market.mean);
    }
    const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
    const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
    let numerator = 0;
    let leftVariance = 0;
    let rightVariance = 0;
    for (let index = 0; index < left.length; index += 1) {
        const leftDelta = left[index]! - leftMean;
        const rightDelta = right[index]! - rightMean;
        numerator += leftDelta * rightDelta;
        leftVariance += leftDelta ** 2;
        rightVariance += rightDelta ** 2;
    }
    return leftVariance > 0 && rightVariance > 0 ? numerator / Math.sqrt(leftVariance * rightVariance) : null;
}

function blankReasons(value: TopMeanPriceFeatureValues): TopMeanPriceFeatureDetails {
    const reasons = {} as Record<TopMeanPriceFeatureField, string>;
    const maxSourceBarEndSec = {} as Record<TopMeanPriceFeatureField, number | null>;
    for (const field of TOP_MEAN_PRICE_FEATURE_FIELDS) {
        reasons[field] = value[field] === null ? "insufficient_history_or_incomplete_session" : "available";
        maxSourceBarEndSec[field] = null;
    }
    return { ...value, reasons, maxSourceBarEndSec };
}

/** Compute all six fields from one asset's causal price prefix. */
export function computeTopMeanPriceFeatureValues(input: TopMeanPriceFeatureInput): TopMeanPriceFeatureValues {
    const d = latestCompleteIndex(input.schedules, input.sessions, input.decisionTimeSec);
    if (d < 0) return {
        priceResidualMomentum5: null,
        priceReversalRate5: null,
        priceVolExpansion5: null,
        priceRelativeVolume1: null,
        priceGapFollowThrough20: null,
        priceCatalogCorrelation20: null,
    };
    return {
        priceResidualMomentum5: residualMomentum(input.schedules, input.sessions, input.catalogReturns, d),
        priceReversalRate5: reversalRate(input.schedules, input.sessions, d),
        priceVolExpansion5: varianceExpansion(input.schedules, input.sessions, d),
        priceRelativeVolume1: relativeVolume(input.schedules, input.sessions, d),
        priceGapFollowThrough20: gapFollowThrough(input.schedules, input.sessions, d),
        priceCatalogCorrelation20: catalogCorrelation(input.schedules, input.sessions, input.catalogReturns, d),
    };
}

export function computeTopMeanPriceFeatures(input: TopMeanPriceFeatureInput): TopMeanPriceFeatureRow {
    return {
        eventId: input.eventId ?? "",
        decisionTimeSec: input.decisionTimeSec,
        asset: input.asset,
        ...computeTopMeanPriceFeatureValues(input),
    };
}

export function explainTopMeanPriceFeatures(input: TopMeanPriceFeatureInput): TopMeanPriceFeatureDetails {
    const values = computeTopMeanPriceFeatureValues(input);
    const details = blankReasons(values);
    const maxSourceBarEndSec = { ...details.maxSourceBarEndSec };
    const d = latestCompleteIndex(input.schedules, input.sessions, input.decisionTimeSec);
    if (d >= 0) {
        const all = requiredSessions(input.schedules, input.sessions, d - 65, d);
        const recent = requiredSessions(input.schedules, input.sessions, d - 24, d);
        const max = rangeSourceEnd(all ?? recent);
        for (const field of TOP_MEAN_PRICE_FEATURE_FIELDS) maxSourceBarEndSec[field] = max;
    }
    return { ...details, maxSourceBarEndSec };
}

/** Build leave-one-out catalog means once for all subject assets. */
export function buildTopMeanLeaveOneOutCatalogReturns(args: {
    assets: readonly string[];
    schedules: readonly TopMeanRegularSessionSchedule[];
    sessionsByAsset: ReadonlyMap<string, ReadonlyMap<string, TopMeanPriceSessionSummary>>;
}): Map<string, Map<string, TopMeanCatalogReturnPoint>> {
    const perDate = new Map<string, Map<string, number>>();
    for (let index = 1; index < args.schedules.length; index += 1) {
        const currentSchedule = args.schedules[index]!;
        const previousSchedule = args.schedules[index - 1]!;
        const returns = new Map<string, number>();
        for (const asset of args.assets) {
            const current = args.sessionsByAsset.get(asset)?.get(currentSchedule.date);
            const previous = args.sessionsByAsset.get(asset)?.get(previousSchedule.date);
            if (!current || !previous || !current.complete || !previous.complete) continue;
            const value = closeReturn(current, previous);
            if (value !== null) returns.set(asset, value);
        }
        perDate.set(currentSchedule.date, returns);
    }
    const output = new Map<string, Map<string, TopMeanCatalogReturnPoint>>();
    for (const asset of args.assets) {
        const byDate = new Map<string, TopMeanCatalogReturnPoint>();
        for (const schedule of args.schedules) {
            const returns = perDate.get(schedule.date) ?? new Map<string, number>();
            let sum = 0;
            let count = 0;
            for (const [peer, value] of returns) {
                if (peer === asset) continue;
                sum += value;
                count += 1;
            }
            byDate.set(schedule.date, {
                mean: count >= TOP_MEAN_PRICE_MIN_CATALOG_PEERS ? sum / count : null,
                peerCount: count,
            });
        }
        output.set(asset, byDate);
    }
    return output;
}
