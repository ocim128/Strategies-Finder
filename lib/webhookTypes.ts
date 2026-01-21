/**
 * Webhook Types - Type definitions for webhook alert system
 * 
 * Defines the data structures for:
 * - Webhook configuration settings
 * - Webhook payloads for signals and trades
 */

import type { Time } from "lightweight-charts";

// ============================================================================
// Webhook Settings
// ============================================================================

export interface WebhookSettings {
    /** Whether webhook alerts are enabled */
    enabled: boolean;
    /** Webhook endpoint URL */
    url: string;
    /** Optional secret key for HMAC payload signing */
    secretKey: string;
    /** Send webhook on each strategy signal */
    sendOnSignal: boolean;
    /** Send webhook on trade entry/exit */
    sendOnTrade: boolean;
}

export const DEFAULT_WEBHOOK_SETTINGS: WebhookSettings = {
    enabled: false,
    url: '',
    secretKey: '',
    sendOnSignal: true,
    sendOnTrade: true,
};

// ============================================================================
// Webhook Payloads
// ============================================================================

export type WebhookEventType = 'signal' | 'trade_entry' | 'trade_exit' | 'backtest_complete';

export interface WebhookSignalData {
    type: 'buy' | 'sell';
    price: number;
    reason?: string;
    time: Time;
}

export interface WebhookTradeData {
    id: number;
    type: 'long' | 'short';
    entryPrice: number;
    exitPrice?: number;
    entryTime?: Time;
    exitTime?: Time;
    pnl?: number;
    pnlPercent?: number;
    size?: number;
}

export interface WebhookStrategyData {
    name: string;
    key: string;
    params: Record<string, number>;
}

export interface WebhookPayload {
    /** ISO timestamp when the event occurred */
    timestamp: string;
    /** Type of event that triggered the webhook */
    eventType: WebhookEventType;
    /** Trading symbol (e.g., ETHUSDT) */
    symbol: string;
    /** Chart interval (e.g., 1d, 4h) */
    interval: string;
    /** Signal data (for signal events) */
    signal?: WebhookSignalData;
    /** Trade data (for trade events) */
    trade?: WebhookTradeData;
    /** Strategy information */
    strategy: WebhookStrategyData;
    /** HMAC-SHA256 signature for verification */
    signature?: string;
}

// ============================================================================
// Webhook Status
// ============================================================================

export interface WebhookStatus {
    /** Number of pending webhooks in queue */
    pending: number;
    /** Timestamp of last successful send */
    lastSuccess?: Date;
    /** Last error message */
    lastError?: string;
    /** Total webhooks sent successfully */
    totalSent: number;
    /** Total failed webhook attempts */
    totalFailed: number;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validates a webhook URL format
 */
export function isValidWebhookUrl(url: string): boolean {
    if (!url || url.trim() === '') return false;

    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}
