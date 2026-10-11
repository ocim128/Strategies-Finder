import type { ISeriesApi } from "lightweight-charts";

export * from './strategies';
export * from './backtest';
export * from './finder';

export * from './scanner';
export * from './data-providers';

export interface Indicator {
    id: string;
    type: string;
    series: ISeriesApi<any>[];
    color: string;
}
