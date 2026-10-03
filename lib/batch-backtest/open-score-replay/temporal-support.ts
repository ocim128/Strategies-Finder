/** Rolling elapsed-time step integrals and linear vote decay. No synthetic bars. */
export class TemporalSupport {
    private histories = new Map<number, { times: number[]; integrals: number[]; values: number[]; head: number }>();
    // Keep weighted seconds rather than fractional slopes: integer vote/time
    // ledgers then expire exactly, without accumulating 1/W rounding drift.
    private fresh = new Map<number, { time: number; value: number; total: number }>();
    private expiry: Array<{ time: number; asset: number; entry: number }> = [];
    private expiryHead = 0;
    private remaining = new Map<string, number>();
    constructor(private readonly window: number, private readonly start: number) {}
    private state(asset: number, time: number) {
        let state = this.fresh.get(asset);
        if (!state) this.fresh.set(asset, state = { time, value: 0, total: 0 });
        state.value -= state.total * (time - state.time); state.time = time; return state;
    }
    advance(time: number): void {
        while (this.expiryHead < this.expiry.length && this.expiry[this.expiryHead]!.time <= time) {
            const item = this.expiry[this.expiryHead++]!, key = `${item.asset}:${item.entry}`;
            const sign = this.remaining.get(key) ?? 0;
            const state = this.state(item.asset, item.time); state.total -= sign;
            this.remaining.delete(key);
        }
        if (this.expiryHead > 4096 && this.expiryHead * 2 > this.expiry.length) { this.expiry = this.expiry.slice(this.expiryHead); this.expiryHead = 0; }
    }
    update(asset: number, time: number, entry: number, delta: number, isEntry: boolean, raw: number): void {
        let history = this.histories.get(asset);
        if (!history) this.histories.set(asset, history = { times: [this.start], integrals: [0], values: [0], head: 0 });
        const last = history.times.length - 1;
        const integral = history.integrals[last]! + history.values[last]! * (time - history.times[last]!);
        if (history.times[last] === time) history.values[last] = raw;
        else { history.times.push(time); history.integrals.push(integral); history.values.push(raw); }
        this.trim(history, time - this.window);
        if (time - entry >= this.window) return; // Expired votes cannot be removed twice.
        const state = this.state(asset, time), key = `${asset}:${entry}`;
        if (isEntry && !this.remaining.has(key)) this.expiry.push({ asset, entry, time: entry + this.window });
        this.remaining.set(key, (this.remaining.get(key) ?? 0) + delta);
        state.value += delta * (this.window - (time - entry)); state.total += delta;
    }
    private trim(history: { times: number[]; integrals: number[]; values: number[]; head: number }, from: number): void {
        while (history.head + 1 < history.times.length && history.times[history.head + 1]! <= from) history.head++;
        if (history.head > 1024 && history.head * 2 > history.times.length) {
            history.times = history.times.slice(history.head); history.integrals = history.integrals.slice(history.head); history.values = history.values.slice(history.head); history.head = 0;
        }
    }
    scores(asset: number, time: number, degree: number): { stable?: number; fresh: number } {
        const fresh = this.state(asset, time).value / (this.window * degree);
        if (time - this.start < this.window) return { fresh };
        const history = this.histories.get(asset);
        if (!history) return { stable: 0, fresh };
        this.trim(history, time - this.window);
        const last = history.times.length - 1, first = history.head;
        const right = history.integrals[last]! + history.values[last]! * (time - history.times[last]!);
        const left = history.integrals[first]! + history.values[first]! * (time - this.window - history.times[first]!);
        return { stable: (right - left) / (this.window * degree), fresh };
    }
}
