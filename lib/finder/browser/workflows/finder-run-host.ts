/**
 * Narrow presentation/lifecycle capabilities a scope workflow may use while a
 * Finder run is in flight. The facade supplies the implementation; workflows
 * never reach back into the manager. Mutable inventories live in
 * `FinderResultStore`, server ownership in `FinderServerSession` — both are
 * passed to workflows explicitly, not through this host.
 */
import type { FinderOptions } from "../../../types/finder";

export interface FinderRunHost {
	setProgress(active: boolean, percent: number, text: string): void;
	setStatus(text: string): void;
	/** Browser cancellation flag for the current run (Stop button). */
	isCancelled(): boolean;
	/** Abort signal for the current browser run, when one is in flight. */
	getAbortSignal(): AbortSignal | undefined;
	/** Yield to the event loop between worker batches. */
	yieldControl(): Promise<void>;
	/** Random-benchmark panel. */
	renderRandomBenchmark(mode: FinderOptions["mode"], payload?: unknown): void;
	renderLatestResults(): void;
	stashAndResetResort(): void;
	populateResortOptions(resetSelection?: boolean): void;
	/** Enable Copy Diagnostics when any diagnostics are available. */
	showDiagnosticsAvailability(available: boolean): void;
}

/** Strategy-loading seams kept with the facade (shared with Apply). */
export interface FinderStrategySource {
	getSelectedStrategies(): Promise<import("../../../finder/finder-runner").FinderSelectedStrategy[]>;
	getUniverseSelectedStrategies(): Promise<import("../../../finder/finder-runner").FinderSelectedStrategy[]>;
	resolveExitStrategyCandidates(
		options: FinderOptions,
		selectedStrategies: import("../../../finder/finder-runner").FinderSelectedStrategy[],
	): Promise<import("../../../finder/finder-runner").FinderSelectedStrategy[] | undefined>;
}

export type FinderSelectedStrategy = import("../../../finder/finder-runner").FinderSelectedStrategy;
