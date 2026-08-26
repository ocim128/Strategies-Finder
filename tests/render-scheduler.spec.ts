import { expect } from "chai";
import { describe, it, mock } from "node:test";
import { debounce } from "../lib/debounce";
import { coalesceAnimationFrame } from "../lib/render-scheduler";

describe("render scheduling helpers", () => {
    it("debounce keeps only the latest call in a burst", async () => {
        const calls: string[] = [];
        const schedule = debounce((value: string) => calls.push(value), 10);
        mock.timers.enable({ apis: ["setTimeout"] });
        try {
            schedule("first");
            schedule("latest");
            mock.timers.tick(10);
            expect(calls).to.deep.equal(["latest"]);
        } finally {
            mock.timers.reset();
        }
    });

    it("debounce cancellation prevents a pending write", async () => {
        let calls = 0;
        const schedule = debounce(() => { calls += 1; }, 10);
        mock.timers.enable({ apis: ["setTimeout"] });
        try {
            schedule();
            schedule.cancel();
            mock.timers.tick(10);
            expect(calls).to.equal(0);
        } finally {
            mock.timers.reset();
        }
    });

    it("debounce flush runs the latest pending call immediately", () => {
        const calls: string[] = [];
        const schedule = debounce((value: string) => calls.push(value), 10);
        mock.timers.enable({ apis: ["setTimeout"] });
        try {
            schedule("latest");
            schedule.flush();
            mock.timers.tick(10);
            expect(calls).to.deep.equal(["latest"]);
        } finally {
            mock.timers.reset();
        }
    });

    it("coalesces multiple schedules into one frame callback", async () => {
        let calls = 0;
        const frame = coalesceAnimationFrame(() => { calls += 1; });
        mock.timers.enable({ apis: ["setTimeout"] });
        try {
            frame.schedule();
            frame.schedule();
            mock.timers.tick(0);
            expect(calls).to.equal(1);
        } finally {
            mock.timers.reset();
        }
    });
});
