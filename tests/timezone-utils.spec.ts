import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TickMarkType, Time } from "lightweight-charts";
import {
    JAKARTA_TIMEZONE,
    formatJakartaTickMark,
    formatJakartaTime,
} from "../lib/timezone-utils";

type FormatterCtor = typeof Intl.DateTimeFormat;

/**
 * Mirrors the module's time parsing so the uncached reference formatter sees
 * the same Date for every supported input shape.
 */
function toReferenceDate(time: Time): Date | null {
    if (typeof time === "number") {
        return new Date(time * 1000);
    }
    if (typeof time === "string") {
        const parsed = Date.parse(time);
        return Number.isNaN(parsed) ? null : new Date(parsed);
    }
    if (typeof time === "object" && time !== null && "year" in time) {
        return new Date(Date.UTC(time.year, time.month - 1, time.day));
    }
    return null;
}

function formatWithUncachedReference(
    time: Time,
    options: Intl.DateTimeFormatOptions,
    locale?: string
): string | { error: string } {
    try {
        const date = toReferenceDate(time);
        if (!date) return String(time);
        return new Intl.DateTimeFormat(locale, {
            ...options,
            timeZone: JAKARTA_TIMEZONE,
        }).format(date);
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * The module reads Intl.DateTimeFormat at call time, so swapping the global
 * constructor observes exactly the construction reuse the cache provides.
 */
function withCountedFormatterCtor<T>(run: (constructions: () => number) => T): T {
    const original = Intl.DateTimeFormat;
    let count = 0;
    class CountingDateTimeFormat extends original {
        constructor(...args: ConstructorParameters<FormatterCtor>) {
            // Count before super(): a throwing constructor must still be seen
            // as an attempted construction.
            count += 1;
            super(...args);
        }
    }
    (Intl as { DateTimeFormat: FormatterCtor }).DateTimeFormat =
        CountingDateTimeFormat as unknown as FormatterCtor;
    try {
        return run(() => count);
    } finally {
        (Intl as { DateTimeFormat: FormatterCtor }).DateTimeFormat = original;
    }
}

/** Output (or failure) must equal a fresh uncached Intl.DateTimeFormat. */
function assertMatchesUncachedReference(
    time: Time,
    options: Intl.DateTimeFormatOptions,
    locale?: string
): void {
    let actual: string | { error: string };
    try {
        actual = formatJakartaTime(time, options, locale);
    } catch (error) {
        actual = { error: error instanceof Error ? error.message : String(error) };
    }
    assert.deepEqual(actual, formatWithUncachedReference(time, options, locale));
}

describe("timezone utils formatter cache", () => {
    const timestampSeconds = Math.floor(Date.UTC(2024, 5, 15, 9, 30, 45) / 1000);
    const numericTime = timestampSeconds as Time;
    const isoTime = "2024-06-15T09:30:45.000Z" as Time;
    const businessDay = { year: 2024, month: 6, day: 15 } as Time;
    const dateTimeOptions: Intl.DateTimeFormatOptions = {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    };

    it("matches uncached Intl output for numeric, string, and BusinessDay times", () => {
        assertMatchesUncachedReference(numericTime, dateTimeOptions);
        assertMatchesUncachedReference(isoTime, dateTimeOptions);
        assertMatchesUncachedReference(
            businessDay,
            { year: "numeric", month: "short", day: "numeric" }
        );
        // Equivalent shapes format identically through the shared formatter.
        assert.equal(
            formatJakartaTime(numericTime, dateTimeOptions),
            formatJakartaTime(isoTime, dateTimeOptions)
        );
    });

    it("matches uncached Intl output for every tick-mark variant", () => {
        const tickMarkType = (value: number) => value as TickMarkType;
        assertMatchesUncachedReference(numericTime, { year: "numeric" }, "en-US");
        assertMatchesUncachedReference(numericTime, { month: "short" }, "en-US");
        assertMatchesUncachedReference(numericTime, { day: "2-digit" }, "en-US");
        assertMatchesUncachedReference(
            numericTime,
            { hour: "2-digit", minute: "2-digit", hour12: false },
            "en-US"
        );
        assertMatchesUncachedReference(
            numericTime,
            { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false },
            "en-US"
        );

        assert.equal(
            formatJakartaTickMark(numericTime, tickMarkType(0), "en-US"),
            formatWithUncachedReference(numericTime, { year: "numeric" }, "en-US")
        );
        assert.equal(
            formatJakartaTickMark(numericTime, tickMarkType(1), "en-US"),
            formatWithUncachedReference(numericTime, { month: "short" }, "en-US")
        );
        assert.equal(
            formatJakartaTickMark(numericTime, tickMarkType(2), "en-US"),
            formatWithUncachedReference(numericTime, { day: "2-digit" }, "en-US")
        );
        assert.equal(
            formatJakartaTickMark(numericTime, tickMarkType(3), "en-US"),
            formatWithUncachedReference(
                numericTime,
                { hour: "2-digit", minute: "2-digit", hour12: false },
                "en-US"
            )
        );
        assert.equal(
            formatJakartaTickMark(numericTime, tickMarkType(4), "en-US"),
            formatWithUncachedReference(
                numericTime,
                { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false },
                "en-US"
            )
        );
        assert.equal(formatJakartaTickMark(numericTime, tickMarkType(99), "en-US"), null);
    });

    it("matches uncached Intl output across locales, including explicit and omitted locales", () => {
        assertMatchesUncachedReference(numericTime, dateTimeOptions);
        assertMatchesUncachedReference(numericTime, dateTimeOptions, "en-US");
        assertMatchesUncachedReference(numericTime, dateTimeOptions, "de-DE");
        assertMatchesUncachedReference(numericTime, dateTimeOptions, "ja-JP");
        assertMatchesUncachedReference(numericTime, dateTimeOptions, "ar-EG");
    });

    it("preserves invalid-input behavior against uncached Intl", () => {
        // Unparseable strings fall back to String(time).
        assertMatchesUncachedReference("not-a-date" as Time, dateTimeOptions);
        assert.equal(formatJakartaTime("not-a-date" as Time, dateTimeOptions), "not-a-date");
        // NaN and malformed BusinessDay values surface the same RangeError as
        // an uncached formatter (Invalid Date cannot be formatted).
        assertMatchesUncachedReference(Number.NaN as Time, dateTimeOptions);
        assertMatchesUncachedReference(
            { year: Number.NaN, month: 1, day: 1 } as unknown as Time,
            dateTimeOptions
        );
        // An invalid locale tag must keep throwing instead of being cached.
        assertMatchesUncachedReference(numericTime, dateTimeOptions, "not a locale");
    });

    it("reuses one construction for equivalent options in different property orders", () => {
        withCountedFormatterCtor((constructions) => {
            const first: Intl.DateTimeFormatOptions = {
                hour12: false,
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
            };
            const second: Intl.DateTimeFormatOptions = {
                second: "2-digit",
                minute: "2-digit",
                hour: "2-digit",
                hour12: false,
            };

            formatJakartaTime(numericTime, first, "en-US");
            const afterFirstCall = constructions();
            formatJakartaTime(numericTime, second, "en-US");

            assert.equal(
                constructions(),
                afterFirstCall,
                "equivalent options in another property order must hit the cache"
            );
            assert.equal(
                formatJakartaTime(numericTime, first, "en-US"),
                formatJakartaTime(numericTime, second, "en-US")
            );
        });
    });

    it("keeps an omitted locale distinct from explicit locales", () => {
        withCountedFormatterCtor((constructions) => {
            const options: Intl.DateTimeFormatOptions = { month: "long" };

            formatJakartaTime(numericTime, options);
            const afterOmitted = constructions();
            formatJakartaTime(numericTime, options, "en-US");

            assert.equal(
                constructions(),
                afterOmitted + 1,
                "an explicit locale must construct its own formatter entry"
            );
            // Repeats of either stay cached.
            formatJakartaTime(numericTime, options);
            formatJakartaTime(numericTime, options, "en-US");
            assert.equal(constructions(), afterOmitted + 1);
        });
    });

    it("never caches on construction failure", () => {
        withCountedFormatterCtor((constructions) => {
            for (let attempt = 0; attempt < 3; attempt += 1) {
                assert.throws(
                    () => formatJakartaTime(numericTime, dateTimeOptions, "not a locale"),
                    RangeError
                );
            }
            assert.equal(
                constructions(),
                3,
                "each failed attempt must construct again instead of serving a cache hit"
            );
        });
    });

    it("evicts the oldest entry once the bounded map overflows", () => {
        withCountedFormatterCtor((constructions) => {
            // Distinct locales produce distinct cache keys (the locale is part
            // of the key); 40 warm entries exceed the 32-entry bound.
            const distinctLocale = (index: number): string => [
                "en-US", "en-GB", "en-AU", "en-CA", "en-IE", "en-IN", "en-NZ", "en-ZA",
                "de-DE", "de-AT", "de-CH", "fr-FR", "fr-CA", "fr-BE", "es-ES", "es-MX",
                "it-IT", "nl-NL", "nl-BE", "pt-BR", "pt-PT", "sv-SE", "da-DK", "nb-NO",
                "fi-FI", "pl-PL", "cs-CZ", "hu-HU", "ro-RO", "el-GR", "tr-TR", "ru-RU",
                "uk-UA", "he-IL", "ar-EG", "fa-IR", "hi-IN", "th-TH", "vi-VN", "id-ID",
            ][index]!;

            // Warm 40 distinct entries (oldest first).
            for (let index = 0; index < 40; index += 1) {
                formatJakartaTime(numericTime, { month: "long" }, distinctLocale(index));
            }
            const afterWarmup = constructions();

            // The oldest entry (index 0) was evicted: re-request constructs.
            formatJakartaTime(numericTime, { month: "long" }, distinctLocale(0));
            assert.equal(constructions(), afterWarmup + 1, "evicted oldest entry must construct again");

            // It is now cached: a repeat must not construct.
            formatJakartaTime(numericTime, { month: "long" }, distinctLocale(0));
            assert.equal(constructions(), afterWarmup + 1);

            // A recent entry (index 39, still inside the 32-entry bound) stays cached.
            formatJakartaTime(numericTime, { month: "long" }, distinctLocale(39));
            assert.equal(constructions(), afterWarmup + 1, "recent entry must remain cached");

            // Output for a re-constructed entry still matches the reference.
            assertMatchesUncachedReference(numericTime, { month: "long" }, distinctLocale(0));
        });
    });
});
