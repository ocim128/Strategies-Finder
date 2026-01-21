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

// ============================================================================
// Enhanced Candlestick Colors - Premium Trading Aesthetic
// ============================================================================

export const ENHANCED_CANDLE_COLORS = {
    // Bullish (green) candles - vibrant teal/emerald
    up: '#00c087',
    upBorder: '#00a876',
    wickUp: '#00c087',

    // Bearish (red) candles - vivid coral/crimson  
    down: '#ff4976',
    downBorder: '#e83e66',
    wickDown: '#ff4976',
};

// Alternative color schemes for customization
export const CANDLE_COLOR_SCHEMES = {
    default: ENHANCED_CANDLE_COLORS,

    classic: {
        up: '#26a69a',
        upBorder: '#26a69a',
        wickUp: '#26a69a',
        down: '#ef5350',
        downBorder: '#ef5350',
        wickDown: '#ef5350',
    },

    tradingView: {
        up: '#089981',
        upBorder: '#089981',
        wickUp: '#089981',
        down: '#f23645',
        downBorder: '#f23645',
        wickDown: '#f23645',
    },

    binance: {
        up: '#0ecb81',
        upBorder: '#0ecb81',
        wickUp: '#0ecb81',
        down: '#f6465d',
        downBorder: '#f6465d',
        wickDown: '#f6465d',
    },

    monochrome: {
        up: '#ffffff',
        upBorder: '#888888',
        wickUp: '#cccccc',
        down: '#444444',
        downBorder: '#222222',
        wickDown: '#666666',
    },
};
