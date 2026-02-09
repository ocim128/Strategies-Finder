/**
 * Webhook Service - Central webhook management for strategy alerts
 * 
 * Features:
 * - Send strategy signals and trade events to external webhooks
 * - HMAC-SHA256 payload signing for verification
 * - Queue system with retry logic
 * - Rate limiting to prevent flooding
 */

import { settingsManager } from "./settings-manager";
import { state } from "./state";
import { debugLogger } from "./debug-logger";
import type { Signal } from './types/strategies';
import type {
    WebhookPayload,
    WebhookEventType,
    WebhookSignalData,
    WebhookTradeData,
    WebhookStrategyData,
    WebhookStatus
} from './types/webhook';

// ============================================================================
// Constants
// ============================================================================

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000; // Base delay, will be exponentially increased
const RATE_LIMIT_MS = 500; // Minimum time between webhook sends
const QUEUE_MAX_SIZE = 100; // Maximum pending webhooks

// ============================================================================
// Queue Item Interface
// ============================================================================

interface QueueItem {
    payload: WebhookPayload;
    retries: number;
    createdAt: Date;
}

// ============================================================================
// Webhook Service Implementation
// ============================================================================

class WebhookService {
    private queue: QueueItem[] = [];
    private isProcessing: boolean = false;
    private lastSendTime: number = 0;
    private status: WebhookStatus = {
        pending: 0,
        totalSent: 0,
        totalFailed: 0
    };
    private listeners: Set<(status: WebhookStatus) => void> = new Set();

    // ========================================================================
    // Public API
    // ========================================================================

    /**
     * Send a strategy signal to the configured webhook
     */
    public async sendSignal(signal: Signal, strategyName: string, strategyParams: Record<string, number>): Promise<void> {
        const settings = settingsManager.getWebhookSettings();

        if (!settings.enabled || !settings.sendOnSignal) {
            return;
        }

        const payload = this.buildPayload('signal', {
            signal: {
                type: signal.type,
                price: signal.price,
                reason: signal.reason,
                time: signal.time
            },
            strategy: {
                name: strategyName,
                key: state.currentStrategyKey,
                params: strategyParams
            }
        });

        await this.enqueue(payload);
    }

    /**
     * Send a trade entry event to the configured webhook
     */
    public async sendTradeEntry(trade: WebhookTradeData, strategyName: string, strategyParams: Record<string, number>): Promise<void> {
        const settings = settingsManager.getWebhookSettings();

        if (!settings.enabled || !settings.sendOnTrade) {
            return;
        }

        const payload = this.buildPayload('trade_entry', {
            trade,
            strategy: {
                name: strategyName,
                key: state.currentStrategyKey,
                params: strategyParams
            }
        });

        await this.enqueue(payload);
    }

    /**
     * Send a trade exit event to the configured webhook
     */
    public async sendTradeExit(trade: WebhookTradeData, strategyName: string, strategyParams: Record<string, number>): Promise<void> {
        const settings = settingsManager.getWebhookSettings();

        if (!settings.enabled || !settings.sendOnTrade) {
            return;
        }

        const payload = this.buildPayload('trade_exit', {
            trade,
            strategy: {
                name: strategyName,
                key: state.currentStrategyKey,
                params: strategyParams
            }
        });

        await this.enqueue(payload);
    }

    /**
     * Get current webhook status
     */
    public getStatus(): WebhookStatus {
        return { ...this.status, pending: this.queue.length };
    }

    /**
     * Subscribe to status updates
     */
    public subscribe(listener: (status: WebhookStatus) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /**
     * Clear the webhook queue
     */
    public clearQueue(): void {
        this.queue = [];
        this.notifyListeners();
        debugLogger.event('webhook.queue.cleared');
    }

    /**
     * Send a test webhook to verify configuration
     * Returns success status and any error message
     */
    public async sendTestWebhook(): Promise<{ success: boolean; error?: string }> {
        const settings = settingsManager.getWebhookSettings();

        if (!settings.url) {
            return { success: false, error: 'No webhook URL configured' };
        }

        const testPayload: WebhookPayload = {
            timestamp: new Date().toISOString(),
            eventType: 'signal', // Use signal type for test
            symbol: state.currentSymbol || 'TEST',
            interval: state.currentInterval || '1d',
            signal: {
                type: 'buy',
                price: 0,
                reason: 'Test webhook from Strategies Finder',
                time: Math.floor(Date.now() / 1000) as any
            },
            strategy: {
                name: 'Test Strategy',
                key: 'test',
                params: {}
            }
        };

        try {
            // Sign the payload if secret key is configured
            const signedPayload = await this.signPayload(testPayload, settings.secretKey);

            const response = await fetch(settings.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Webhook-Source': 'strategies-finder',
                    'X-Webhook-Event': 'test',
                    ...(signedPayload.signature && {
                        'X-Webhook-Signature': signedPayload.signature
                    })
                },
                body: JSON.stringify(signedPayload),
                mode: 'cors',
            });

            if (response.ok) {
                debugLogger.event('webhook.test.success', { url: settings.url });
                return { success: true };
            } else {
                const error = `HTTP ${response.status}: ${response.statusText}`;
                debugLogger.event('webhook.test.failed', { url: settings.url, status: response.status });
                return { success: false, error };
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            debugLogger.event('webhook.test.error', { url: settings.url, error: errorMessage });
            return { success: false, error: errorMessage };
        }
    }

    // ========================================================================
    // Payload Building
    // ========================================================================

    private buildPayload(eventType: WebhookEventType, data: {
        signal?: WebhookSignalData;
        trade?: WebhookTradeData;
        strategy: WebhookStrategyData;
    }): WebhookPayload {
        const payload: WebhookPayload = {
            timestamp: new Date().toISOString(),
            eventType,
            symbol: state.currentSymbol,
            interval: state.currentInterval,
            strategy: data.strategy
        };

        if (data.signal) {
            payload.signal = data.signal;
        }

        if (data.trade) {
            payload.trade = data.trade;
        }

        return payload;
    }

    // ========================================================================
    // Queue Management
    // ========================================================================

    private async enqueue(payload: WebhookPayload): Promise<void> {
        // Check queue size limit
        if (this.queue.length >= QUEUE_MAX_SIZE) {
            debugLogger.event('webhook.queue.full', { size: this.queue.length });
            // Remove oldest item
            this.queue.shift();
        }

        this.queue.push({
            payload,
            retries: 0,
            createdAt: new Date()
        });

        this.notifyListeners();

        // Start processing if not already running
        if (!this.isProcessing) {
            this.processQueue();
        }
    }

    private async processQueue(): Promise<void> {
        if (this.isProcessing || this.queue.length === 0) {
            return;
        }

        this.isProcessing = true;

        while (this.queue.length > 0) {
            const item = this.queue[0];

            // Rate limiting
            const timeSinceLastSend = Date.now() - this.lastSendTime;
            if (timeSinceLastSend < RATE_LIMIT_MS) {
                await this.sleep(RATE_LIMIT_MS - timeSinceLastSend);
            }

            const success = await this.sendPayload(item);

            if (success) {
                // Remove from queue on success
                this.queue.shift();
                this.status.totalSent++;
                this.status.lastSuccess = new Date();
                delete this.status.lastError;
            } else {
                item.retries++;

                if (item.retries >= MAX_RETRIES) {
                    // Give up after max retries
                    this.queue.shift();
                    this.status.totalFailed++;
                    debugLogger.event('webhook.failed.max_retries', {
                        eventType: item.payload.eventType,
                        retries: item.retries
                    });
                } else {
                    // Exponential backoff
                    const delay = RETRY_DELAY_MS * Math.pow(2, item.retries);
                    debugLogger.event('webhook.retry', {
                        eventType: item.payload.eventType,
                        retry: item.retries,
                        delay
                    });
                    await this.sleep(delay);
                }
            }

            this.lastSendTime = Date.now();
            this.notifyListeners();
        }

        this.isProcessing = false;
    }

    // ========================================================================
    // HTTP Sending
    // ========================================================================

    private async sendPayload(item: QueueItem): Promise<boolean> {
        const settings = settingsManager.getWebhookSettings();

        if (!settings.url) {
            this.status.lastError = 'No webhook URL configured';
            return false;
        }

        try {
            // Sign the payload if secret key is configured
            const signedPayload = await this.signPayload(item.payload, settings.secretKey);

            const response = await fetch(settings.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Webhook-Source': 'strategies-finder',
                    'X-Webhook-Event': item.payload.eventType,
                    ...(signedPayload.signature && {
                        'X-Webhook-Signature': signedPayload.signature
                    })
                },
                body: JSON.stringify(signedPayload),
                mode: 'cors',
            });

            if (response.ok) {
                debugLogger.event('webhook.sent', {
                    eventType: item.payload.eventType,
                    symbol: item.payload.symbol,
                    status: response.status
                });
                // Add to activity log
                this.addActivityLogEntry(`${item.payload.eventType} → ${item.payload.symbol}`, 'success');
                return true;
            } else {
                this.status.lastError = `HTTP ${response.status}: ${response.statusText}`;
                debugLogger.event('webhook.error.http', {
                    eventType: item.payload.eventType,
                    status: response.status,
                    statusText: response.statusText
                });
                // Add to activity log
                this.addActivityLogEntry(`${item.payload.eventType} → HTTP ${response.status}`, 'failed');
                return false;
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.status.lastError = errorMessage;
            debugLogger.event('webhook.error.network', {
                eventType: item.payload.eventType,
                error: errorMessage
            });
            // Add to activity log
            this.addActivityLogEntry(`${item.payload.eventType} → ${errorMessage.slice(0, 30)}`, 'failed');
            return false;
        }
    }

    // ========================================================================
    // HMAC Signing
    // ========================================================================

    private async signPayload(payload: WebhookPayload, secretKey: string): Promise<WebhookPayload> {
        if (!secretKey || secretKey.trim() === '') {
            return payload;
        }

        try {
            // Create signature using Web Crypto API
            const encoder = new TextEncoder();
            const data = encoder.encode(JSON.stringify(payload));

            // Import the secret key
            const key = await crypto.subtle.importKey(
                'raw',
                encoder.encode(secretKey),
                { name: 'HMAC', hash: 'SHA-256' },
                false,
                ['sign']
            );

            // Sign the payload
            const signatureBuffer = await crypto.subtle.sign('HMAC', key, data);

            // Convert to hex string
            const signatureArray = Array.from(new Uint8Array(signatureBuffer));
            const signature = signatureArray.map(b => b.toString(16).padStart(2, '0')).join('');

            return {
                ...payload,
                signature
            };
        } catch (error) {
            debugLogger.event('webhook.sign.error', {
                error: error instanceof Error ? error.message : 'Unknown error'
            });
            // Return unsigned payload if signing fails
            return payload;
        }
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private notifyListeners(): void {
        const status = this.getStatus();
        this.listeners.forEach(listener => {
            try {
                listener(status);
            } catch (e) {
                console.error('[WebhookService] Listener error:', e);
            }
        });
    }

    /**
     * Add an entry to the UI activity log (async import to avoid circular deps)
     */
    private async addActivityLogEntry(event: string, status: 'success' | 'pending' | 'failed'): Promise<void> {
        try {
            const { addWebhookActivityEntry } = await import('./handlers/settings-handlers');
            addWebhookActivityEntry(event, status);
        } catch (e) {
            // Silently fail if UI is not available
        }
    }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const webhookService = new WebhookService();

// Export for debugging
if (typeof window !== 'undefined') {
    (window as any).__webhookService = webhookService;
}



