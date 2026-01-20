import { ChartOptions, DeepPartial, CrosshairMode, LineStyle, ColorType } from "lightweight-charts";

export const SYMBOL_MAP: Record<string, string> = {
    'ETHUSDT': 'ETH/USDT',
    'BTCUSDT': 'BTC/USDT',
    'SOLUSDT': 'SOL/USDT',
    'BNBUSDT': 'BNB/USDT',
    'XRPUSDT': 'XRP/USDT',
    'ADAUSDT': 'ADA/USDT',
    'DOGEUSDT': 'DOGE/USDT',
    'AVAXUSDT': 'AVAX/USDT',
    'AAPL': 'AAPL (Apple)',
    'GOOGL': 'GOOGL (Google)',
    'MSFT': 'MSFT (Microsoft)',
    'TSLA': 'TSLA (Tesla)',
    'EURUSD': 'EUR/USD',
    'GBPUSD': 'GBP/USD',
    'USDJPY': 'USD/JPY',
    'XAUUSD': 'XAU/USD (Gold)',
    'XAGUSD': 'XAG/USD (Silver)',
    'WTIUSD': 'WTI Oil',
};

export const darkTheme: DeepPartial<ChartOptions> = {
    layout: {
        textColor: '#d1d4dc',
        background: { type: ColorType.Solid, color: '#131722' },
    },
    grid: {
        vertLines: { color: '#1e222d' },
        horzLines: { color: '#1e222d' },
    },
    crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
            color: '#758696',
            width: 1,
            style: LineStyle.Dashed,
            labelBackgroundColor: '#2962ff',
        },
        horzLine: {
            color: '#758696',
            width: 1,
            style: LineStyle.Dashed,
            labelBackgroundColor: '#2962ff',
        },
    },
    rightPriceScale: {
        borderColor: '#2a2e39',
    },
    timeScale: {
        borderColor: '#2a2e39',
        timeVisible: true,
        secondsVisible: false,
    },
};

export const lightTheme: DeepPartial<ChartOptions> = {
    layout: {
        textColor: '#131722',
        background: { type: ColorType.Solid, color: '#ffffff' },
    },
    grid: {
        vertLines: { color: '#e0e3eb' },
        horzLines: { color: '#e0e3eb' },
    },
    crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
            color: '#9598a1',
            width: 1,
            style: LineStyle.Dashed,
            labelBackgroundColor: '#2962ff',
        },
        horzLine: {
            color: '#9598a1',
            width: 1,
            style: LineStyle.Dashed,
            labelBackgroundColor: '#2962ff',
        },
    },
    rightPriceScale: {
        borderColor: '#e0e3eb',
    },
    timeScale: {
        borderColor: '#e0e3eb',
        timeVisible: true,
        secondsVisible: false,
    },
};
