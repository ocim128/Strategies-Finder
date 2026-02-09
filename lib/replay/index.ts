/**
 * Replay Module - Entry Point
 * 
 * Exports all replay-related functionality for bar-by-bar
 * strategy signal visualization.
 */

export { ReplayManager, replayManager } from './replay-manager';
export { ReplayChartAdapter } from './replay-chart-adapter';
export { ReplayUI } from './replay-ui';

export type {
    // Status & Speed
    ReplayStatus,
    ReplaySpeedConfig,

    // State
    ReplayState,
    SignalWithAnnotation,

    // Events
    ReplayEventType,
    ReplayEvent,
    ReplayEventListener,

    // Options
    ReplayStartOptions,
    ReplaySeekOptions,

    // Interface
    IReplayManager,
} from '../types/replay';

export { DEFAULT_SPEED_CONFIG } from '../types/replay';

