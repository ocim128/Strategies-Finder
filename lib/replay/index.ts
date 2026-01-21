/**
 * Replay Module - Entry Point
 * 
 * Exports all replay-related functionality for bar-by-bar
 * strategy signal visualization.
 */

export { ReplayManager, replayManager } from './replayManager';
export { ReplayChartAdapter } from './replayChartAdapter';
export { ReplayUI } from './replayUI';

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
} from './replayTypes';

export { DEFAULT_SPEED_CONFIG } from './replayTypes';
