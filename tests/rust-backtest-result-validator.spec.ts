import { expect } from 'chai';
import { describe, it } from 'node:test';
import { validateRustBacktestResult } from '../lib/rust-backtest-result-validator';

/**
 * The Rust engine returns results over the wire; this validator is the only
 * gate before they reach renderers and the TS/Rust parity checks. It has
 * several independent failure modes (shape, per-trade fields, per-equity
 * fields, count reconciliation, winRate/avgTrade reconciliation and the
 * profitFactor normalization matrix), so each branch is pinned here.
 */

type Raw = Record<string, unknown>;

function trade(overrides: Raw = {}): Raw {
    return {
        id: 0,
        type: 'long',
        entryTime: 1_700_000_000,
        entryPrice: 100,
        exitTime: 1_700_003_600,
        exitPrice: 101,
        pnl: 1,
        pnlPercent: 1,
        size: 1,
        ...overrides,
    };
}

function result(overrides: Raw = {}): Raw {
    return {
        trades: [trade()],
        equityCurve: [{ time: 1_700_000_000, value: 10_000 }],
        netProfit: 100,
        netProfitPercent: 1,
        winRate: 50,
        expectancy: 50,
        avgTrade: 50,
        profitFactor: 2,
        maxDrawdown: 10,
        maxDrawdownPercent: 1,
        totalTrades: 2,
        winningTrades: 1,
        losingTrades: 1,
        avgWin: 100,
        avgLoss: -50,
        sharpeRatio: 1,
        ...overrides,
    };
}

describe('validateRustBacktestResult: shape and metric guards', () => {
    it('accepts a well-formed result and returns it with normalized profitFactor', () => {
        const validation = validateRustBacktestResult(result());
        expect(validation.ok).to.equal(true);
        if (validation.ok) {
            expect(validation.result.profitFactor).to.equal(2);
            expect(validation.result.trades).to.have.lengthOf(1);
        }
    });

    it('rejects non-object payloads', () => {
        for (const value of [null, undefined, 42, 'x', true]) {
            const validation = validateRustBacktestResult(value);
            expect(validation.ok).to.equal(false);
            if (!validation.ok) expect(validation.reason).to.equal('malformed_response');
        }
    });

    it('rejects missing trades or equityCurve arrays', () => {
        expect(validateRustBacktestResult(result({ trades: null })).ok).to.equal(false);
        expect(validateRustBacktestResult(result({ equityCurve: {} })).ok).to.equal(false);
    });

    it('rejects a non-finite summary metric', () => {
        const validation = validateRustBacktestResult(result({ netProfit: Number.NaN }));
        expect(validation.ok).to.equal(false);
        if (!validation.ok) expect(validation.message).to.contain('non-finite metric');
    });
});

describe('validateRustBacktestResult: per-trade guards', () => {
    it('rejects a non-integer or negative id', () => {
        expect(validateRustBacktestResult(result({ trades: [trade({ id: 1.5 })] })).ok).to.equal(false);
        expect(validateRustBacktestResult(result({ trades: [trade({ id: -1 })] })).ok).to.equal(false);
    });

    it('rejects an unknown trade type', () => {
        expect(validateRustBacktestResult(result({ trades: [trade({ type: 'both' })] })).ok).to.equal(false);
    });

    it('rejects unparseable entry or exit times', () => {
        expect(validateRustBacktestResult(result({ trades: [trade({ entryTime: null })] })).ok).to.equal(false);
        expect(validateRustBacktestResult(result({ trades: [trade({ exitTime: 'not-a-time' })] })).ok).to.equal(false);
    });

    it('accepts normalized string and business-day time shapes', () => {
        const validation = validateRustBacktestResult(result({
            trades: [trade({
                entryTime: '2023-11-14T22:13:20.000Z',
                exitTime: { year: 2023, month: 11, day: 15 },
            })],
        }));
        expect(validation.ok).to.equal(true);
    });

    it('rejects a non-finite numeric trade field', () => {
        expect(validateRustBacktestResult(result({ trades: [trade({ pnl: Number.POSITIVE_INFINITY })] })).ok).to.equal(false);
        expect(validateRustBacktestResult(result({ trades: [trade({ size: 'big' })] })).ok).to.equal(false);
    });

    it('rejects a non-string exitReason and a non-finite fees value', () => {
        expect(validateRustBacktestResult(result({ trades: [trade({ exitReason: 7 })] })).ok).to.equal(false);
        expect(validateRustBacktestResult(result({ trades: [trade({ fees: Number.NaN })] })).ok).to.equal(false);
    });

    it('allows omitted exitReason and null fees by default', () => {
        expect(validateRustBacktestResult(result({ trades: [trade({ fees: null })] })).ok).to.equal(true);
    });

    it('requires exitReason when the caller asks for it', () => {
        const missing = validateRustBacktestResult(result(), { requireExitReason: true });
        expect(missing.ok).to.equal(false);
        if (!missing.ok) expect(missing.message).to.contain('missing exitReason');

        const present = validateRustBacktestResult(
            result({ trades: [trade({ exitReason: 'take_profit' })] }),
            { requireExitReason: true },
        );
        expect(present.ok).to.equal(true);
    });
});

describe('validateRustBacktestResult: equity curve guards', () => {
    it('rejects a non-object equity point', () => {
        expect(validateRustBacktestResult(result({ equityCurve: [null] })).ok).to.equal(false);
    });

    it('rejects an equity point with an invalid time or value', () => {
        expect(validateRustBacktestResult(result({ equityCurve: [{ time: 'bad', value: 1 }] })).ok).to.equal(false);
        expect(validateRustBacktestResult(result({ equityCurve: [{ time: 1, value: Number.NaN }] })).ok).to.equal(false);
    });
});

describe('validateRustBacktestResult: reconciliation guards', () => {
    it('rejects non-integer or negative trade counts', () => {
        expect(validateRustBacktestResult(result({ totalTrades: -1, winningTrades: -1, losingTrades: 0 })).ok).to.equal(false);
        expect(validateRustBacktestResult(result({ totalTrades: 1.5 })).ok).to.equal(false);
    });

    it('rejects trade counts that do not reconcile', () => {
        const validation = validateRustBacktestResult(result({ totalTrades: 5, winningTrades: 1, losingTrades: 1 }));
        expect(validation.ok).to.equal(false);
        if (!validation.ok) expect(validation.message).to.contain('do not reconcile');
    });

    it('rejects a winRate that disagrees with the counts', () => {
        const validation = validateRustBacktestResult(result({ winRate: 40 }));
        expect(validation.ok).to.equal(false);
        if (!validation.ok) expect(validation.message).to.contain('winRate does not reconcile');
    });

    it('rejects an avgTrade outside tolerance of netProfit / totalTrades', () => {
        const validation = validateRustBacktestResult(result({ avgTrade: 200 }));
        expect(validation.ok).to.equal(false);
        if (!validation.ok) expect(validation.message).to.contain('avgTrade does not reconcile');
    });

    it('skips winRate/avgTrade reconciliation when there are no trades', () => {
        const validation = validateRustBacktestResult(result({
            trades: [],
            equityCurve: [],
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
            netProfit: 0,
            winRate: 0,
            avgTrade: 0,
            profitFactor: null,
        }));
        expect(validation.ok).to.equal(true);
        if (validation.ok) expect(validation.result.profitFactor).to.equal(0);
    });
});

describe('validateRustBacktestResult: profitFactor normalization matrix', () => {
    it('keeps finite and +Infinity profitFactor values', () => {
        const finite = validateRustBacktestResult(result({ profitFactor: 1.25 }));
        expect(finite.ok).to.equal(true);
        if (finite.ok) expect(finite.result.profitFactor).to.equal(1.25);

        const infinite = validateRustBacktestResult(result({
            profitFactor: Number.POSITIVE_INFINITY,
            totalTrades: 2,
            winningTrades: 2,
            losingTrades: 0,
            winRate: 100,
            netProfit: 100,
            avgTrade: 50,
        }));
        expect(infinite.ok).to.equal(true);
        if (infinite.ok) expect(infinite.result.profitFactor).to.equal(Number.POSITIVE_INFINITY);
    });

    it('derives +Infinity for null profitFactor with only winners', () => {
        const validation = validateRustBacktestResult(result({
            profitFactor: null,
            totalTrades: 2,
            winningTrades: 2,
            losingTrades: 0,
            winRate: 100,
            netProfit: 100,
            avgTrade: 50,
        }));
        expect(validation.ok).to.equal(true);
        if (validation.ok) expect(validation.result.profitFactor).to.equal(Number.POSITIVE_INFINITY);
    });

    it('rejects an unresolvable null profitFactor when both sides traded', () => {
        const validation = validateRustBacktestResult(result({ profitFactor: null }));
        expect(validation.ok).to.equal(false);
        if (!validation.ok) expect(validation.message).to.contain('invalid profitFactor');
    });

    it('rejects NaN, -Infinity, strings and undefined profitFactor', () => {
        for (const bad of [Number.NaN, Number.NEGATIVE_INFINITY, '2', undefined]) {
            const validation = validateRustBacktestResult(result({ profitFactor: bad }));
            expect(validation.ok).to.equal(false);
        }
    });
});
