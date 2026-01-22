/**
 * Engine Status Indicator
 *
 * Shows whether the Rust backend is connected and being used.
 */

import { rustEngine, getEngineStatus } from './rustEngineClient';
import { getEnginePreference, toggleEnginePreference } from './enginePreferences';

// ============================================================================
// Status Indicator Component
// ============================================================================

let statusElement: HTMLElement | null = null;
let statusInterval: number | null = null;

/**
 * Initialize the engine status indicator in the header
 */
export function initEngineStatusIndicator(): void {
    // Create status element if it doesn't exist
    statusElement = document.getElementById('engineStatus');

    if (!statusElement) {
        // Look for the header to append the indicator
        const header = document.querySelector('.panel-header')
            || document.querySelector('header')
            || document.querySelector('.controls-section');

        if (header) {
            statusElement = document.createElement('span');
            statusElement.id = 'engineStatus';
            statusElement.className = 'engine-status';
            statusElement.title = 'Backend engine status';
            const actions = header.querySelector('.panel-actions') || header;
            actions.appendChild(statusElement);
        }
    }

    if (statusElement) {
        statusElement.setAttribute('role', 'button');
        statusElement.setAttribute('tabindex', '0');
        statusElement.addEventListener('click', () => {
            toggleEnginePreference();
            updateStatus();
        });
        statusElement.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggleEnginePreference();
                updateStatus();
            }
        });
    }

    // Initial check
    updateStatus();

    // Periodic check every 30 seconds
    if (statusInterval) {
        clearInterval(statusInterval);
    }
    statusInterval = window.setInterval(updateStatus, 30000);
}

/**
 * Update the status indicator
 */
async function updateStatus(): Promise<void> {
    if (!statusElement) return;

    const preference = getEnginePreference();
    if (preference === 'typescript') {
        statusElement.innerHTML = 'TS';
        statusElement.className = 'engine-status engine-typescript';
        statusElement.title = 'TypeScript backend (Rust disabled). Click to toggle.';
        return;
    }

    const isAvailable = await rustEngine.checkHealth();

    if (isAvailable) {
        statusElement.innerHTML = 'RUST';
        statusElement.className = 'engine-status engine-rust';
        statusElement.title = 'Rust backend (high performance). Click to toggle.';
    } else {
        statusElement.innerHTML = 'TS';
        statusElement.className = 'engine-status engine-typescript';
        statusElement.title = 'TypeScript backend (Rust server not running). Click to toggle.';
    }
}

/**
 * Force refresh the status
 */
export async function refreshEngineStatus(): Promise<void> {
    await updateStatus();
}

/**
 * Get current engine info for display
 */
export async function getEngineInfo(): Promise<{
    engine: 'rust' | 'typescript';
    status: string;
    color: string;
}> {
    const preference = getEnginePreference();
    if (preference === 'typescript') {
        return {
            engine: 'typescript',
            status: 'TypeScript (forced)',
            color: '#3178c6'
        };
    }

    const status = await getEngineStatus();

    if (status.engine === 'rust') {
        return {
            engine: 'rust',
            status: `Rust v${status.version || '0.1.0'}`,
            color: '#ff6b35'
        };
    }

    return {
        engine: 'typescript',
        status: 'TypeScript (fallback)',
        color: '#3178c6'
    };
}
