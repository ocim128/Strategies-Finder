import { expect } from "chai";
import { describe, it } from "node:test";
import { debounce } from "../lib/debounce";
import { coalesceAnimationFrame } from "../lib/render-scheduler";

describe("render scheduling helpers", () => {
    it("debounce keeps only the latest call in a burst", async () => {
        const calls: string[] = [];
        const schedule = debounce((value: string) => calls.push(value), 10);

        schedule("first");
        schedule("latest");
        await new Promise((resolve) => setTimeout(resolve, 25));

        expect(calls).to.deep.equal(["latest"]);
    });

    it("debounce cancellation prevents a pending write", async () => {
        let calls = 0;
        const schedule = debounce(() => { calls += 1; }, 10);

        schedule();
        schedule.cancel();
        await new Promise((resolve) => setTimeout(resolve, 25));

        expect(calls).to.equal(0);
    });

    it("coalesces multiple schedules into one frame callback", async () => {
        let calls = 0;
        const frame = coalesceAnimationFrame(() => { calls += 1; });

        frame.schedule();
        frame.schedule();
        await new Promise((resolve) => setTimeout(resolve, 25));

        expect(calls).to.equal(1);
    });
});
