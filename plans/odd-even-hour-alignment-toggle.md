# Plan: Odd/Even Hour Alignment Toggle for 2H Timeframe

## Overview
Add a toggle feature to switch between odd and even closed hours for the 2H timeframe. This allows testing strategies on both alignment variants to verify performance across different bar boundaries.

## Current Behavior
- Binance's 2H bars are aligned to **even hours** by default (0:00, 2:00, 4:00, 6:00, etc.)
- This is based on Unix epoch alignment where `Math.floor(time / 7200) * 7200`
- No current option to switch to odd hour alignment (1:00, 3:00, 5:00, 7:00, etc.)

## Technical Approach

### 1. Add New Setting
**File:** `lib/settings-manager.ts`

Add a new setting field to the `BacktestSettingsData` interface:
```typescript
export interface BacktestSettingsData {
    // ... existing fields ...
    
    // Hour alignment for multi-hour timeframes (2H, 4H, etc.)
    hourAlignmentMode: 'even' | 'odd'; // 'even' = bars close at even hours, 'odd' = bars close at odd hours
}
```

Add default value in `DEFAULT_BACKTEST_SETTINGS`:
```typescript
const DEFAULT_BACKTEST_SETTINGS: BacktestSettingsData = {
    // ... existing defaults ...
    hourAlignmentMode: 'even', // Default to even hour alignment
};
```

### 2. Modify Resampling Logic
**File:** `lib/strategies/resample-utils.ts`

Add a new function to apply hour offset:
```typescript
/**
 * Applies an hour offset to OHLCV data for odd/even alignment
 * @param data - Original OHLCV data
 * @param targetInterval - Target interval string (e.g., '2h', '4h')
 * @param alignmentMode - 'even' (default) or 'odd'
 * @returns Offset OHLCV data
 */
export function applyHourAlignment(
    data: OHLCVData[], 
    targetInterval: string, 
    alignmentMode: 'even' | 'odd'
): OHLCVData[] {
    if (alignmentMode === 'even' || data.length === 0) {
        return data;
    }
    
    const intervalSeconds = getIntervalSeconds(targetInterval);
    
    // For odd alignment, we need to offset by 1 hour (3600 seconds)
    // This shifts bars from even hours to odd hours
    const offsetSeconds = 3600;
    
    return data.map(bar => ({
        ...bar,
        time: (Number(bar.time) + offsetSeconds) as Time,
    }));
}
```

Modify the `resampleOHLCV` function to accept an optional alignment parameter:
```typescript
export function resampleOHLCV(
    data: OHLCVData[], 
    targetInterval: string,
    alignmentMode: 'even' | 'odd' = 'even'
): OHLCVData[] {
    if (data.length === 0) return [];

    const sourceIntervalSeconds = data.length > 1
        ? (typeof data[1].time === 'number' && typeof data[0].time === 'number'
            ? (data[1].time - data[0].time)
            : 60)
        : 60;

    const targetIntervalSeconds = getIntervalSeconds(targetInterval);

    if (targetIntervalSeconds <= sourceIntervalSeconds) return data;

    const resampled: OHLCVData[] = [];
    let currentBar: OHLCVData | null = null;
    let currentPeriodStart = -1;

    // Calculate offset for odd alignment
    const offset = alignmentMode === 'odd' ? 3600 : 0;

    for (const bar of data) {
        const time = typeof bar.time === 'number' ? bar.time : 0;
        // Apply offset before calculating period start
        const adjustedTime = time + offset;
        const periodStart = Math.floor(adjustedTime / targetIntervalSeconds) * targetIntervalSeconds - offset;

        if (periodStart !== currentPeriodStart) {
            if (currentBar) {
                resampled.push(currentBar);
            }
            currentBar = {
                time: periodStart as Time,
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                volume: bar.volume
            };
            currentPeriodStart = periodStart;
        } else if (currentBar) {
            currentBar.high = Math.max(currentBar.high, bar.high);
            currentBar.low = Math.min(currentBar.low, bar.low);
            currentBar.close = bar.close;
            currentBar.volume += bar.volume;
        }
    }

    if (currentBar) {
        resampled.push(currentBar);
    }

    return resampled;
}
```

### 3. Update Data Providers
**File:** `lib/dataProviders/binance.ts`

Modify `fetchBinanceData` to accept and use alignment mode:
```typescript
export async function fetchBinanceData(
    symbol: string, 
    interval: string, 
    signal?: AbortSignal,
    alignmentMode: 'even' | 'odd' = 'even'
): Promise<OHLCVData[]> {
    try {
        const batches: BinanceKline[][] = [];
        const { sourceInterval, needsResample } = resolveFetchInterval(interval);
        // ... existing fetch logic ...

        const allRawData = batches.reverse().flat();
        const mapped = mapToOHLCV(allRawData);

        if (needsResample) {
            const resampled = resampleOHLCV(mapped, interval, alignmentMode);
            // ... existing debug logging ...
            return resampled;
        }

        // For native 2H intervals from Binance, apply offset if odd alignment
        if (alignmentMode === 'odd' && (interval === '2h' || interval === '4h' || interval === '6h')) {
            return mapped.map(bar => ({
                ...bar,
                time: (Number(bar.time) + 3600) as Time,
            }));
        }

        return mapped;
        // ... existing error handling ...
    } catch (error) {
        // ... existing error handling ...
    }
}
```

Similarly update `fetchBinanceDataWithLimit`:
```typescript
export async function fetchBinanceDataWithLimit(
    symbol: string,
    interval: string,
    totalBars: number,
    options?: HistoricalFetchOptions & { alignmentMode?: 'even' | 'odd' }
): Promise<OHLCVData[]> {
    const alignmentMode = options?.alignmentMode ?? 'even';
    // ... existing logic ...
    
    if (needsResample) {
        const resampled = resampleOHLCV(mapped, interval, alignmentMode);
        return resampled.slice(-targetBars);
    }
    
    // Apply offset for native multi-hour intervals
    if (alignmentMode === 'odd' && (interval === '2h' || interval === '4h' || interval === '6h')) {
        return mapped.map(bar => ({
            ...bar,
            time: (Number(bar.time) + 3600) as Time,
        })).slice(-targetBars);
    }
    
    return mapped.slice(-targetBars);
    // ... rest of function ...
}
```

### 4. Update Data Manager
**File:** `lib/data-manager.ts`

Add a method to get the current alignment mode from settings:
```typescript
private getHourAlignmentMode(): 'even' | 'odd' {
    // Import settingsManager at top of file
    return settingsManager.getBacktestSettings().hourAlignmentMode;
}
```

Update `fetchBinanceDataHybrid` to pass alignment mode:
```typescript
private async fetchBinanceDataHybrid(
    symbol: string,
    interval: string,
    signal?: AbortSignal,
    options?: { localOnlyIfPresent?: boolean; maxBars?: number }
): Promise<OHLCVData[]> {
    // ... existing code ...
    
    const alignmentMode = this.getHourAlignmentMode();
    
    // When fetching remote data, pass alignment mode
    if (hasMaxBars) {
        remoteData = await fetchBinanceDataWithLimit(symbol, interval, effectiveMaxBars, {
            signal,
            requestDelayMs: 80,
            maxRequests: 60,
            alignmentMode,
        });
    } else {
        remoteData = await fetchBinanceData(symbol, interval, signal, alignmentMode);
    }
    
    // ... rest of function ...
}
```

**Note:** For cached data (SQLite, IndexedDB, seed files), the alignment mode setting at the time of caching determines the alignment. This is acceptable as users can clear cache to switch alignment modes.

### 5. Add UI Controls
**File:** `html-partials/tab-settings.html`

Add a new section in the settings tab (after "Execution Realism" section would be appropriate):

```html
<!-- Hour Alignment Section -->
<div class="settings-section">
    <div class="section-header">
        <span class="section-title">Hour Alignment</span>
        <label class="section-toggle" style="transform: scale(0.8);"
            aria-label="Toggle odd hour alignment">
            <input type="checkbox" id="hourAlignmentToggle">
            <span class="toggle-slider"></span>
        </label>
    </div>
    <div class="section-body">
        <div class="param-row">
            <label class="param-label">
                Alignment Mode
                <span class="tooltip-icon"
                    data-tooltip="For 2H+ timeframes: Even = bars close at 0:00, 2:00, 4:00... Odd = bars close at 1:00, 3:00, 5:00... Default: Even">&#9432;</span>
            </label>
            <select class="param-input" id="hourAlignmentSelect">
                <option value="even">Even Hours (0:00, 2:00, 4:00...)</option>
                <option value="odd">Odd Hours (1:00, 3:00, 5:00...)</option>
            </select>
        </div>
        <div class="param-hint">Clear cache after changing alignment mode to ensure data is re-fetched with new alignment.</div>
    </div>
</div>
```

### 6. Add UI Handlers
**File:** `lib/handlers/settings-handlers.ts`

Add handler for the hour alignment setting:

```typescript
export function setupSettingsHandlers() {
    // ... existing handlers ...
    
    // Hour Alignment Mode
    const hourAlignmentSelect = document.getElementById('hourAlignmentSelect') as HTMLSelectElement | null;
    if (hourAlignmentSelect) {
        // Load current value
        const currentAlignment = settingsManager.getBacktestSettings().hourAlignmentMode;
        hourAlignmentSelect.value = currentAlignment;
        
        // Handle changes
        hourAlignmentSelect.addEventListener('change', (e) => {
            const value = (e.target as HTMLSelectElement).value as 'even' | 'odd';
            settingsManager.updateBacktestSetting('hourAlignmentMode', value);
            debugLogger.event('ui.settings.hour_alignment_changed', { value });
            
            // Show warning about cache
            uiManager.showToast(
                'Hour alignment changed. Clear cache and reload data to apply new alignment.',
                'info',
                5000
            );
        });
    }
}
```

### 7. Add Cache Clear Helper (Optional Enhancement)
**File:** `html-partials/tab-settings.html`

Add a button to clear cache in the Hour Alignment section:

```html
<div class="param-row">
    <button class="btn-secondary" id="clearCacheBtn" type="button">
        Clear Cache & Reload
    </button>
</div>
```

**File:** `lib/handlers/settings-handlers.ts`

```typescript
// Clear Cache button
const clearCacheBtn = document.getElementById('clearCacheBtn');
if (clearCacheBtn) {
    clearCacheBtn.addEventListener('click', async () => {
        if (confirm('Clear all cached data? This will re-fetch data from the network.')) {
            // Clear IndexedDB cache
            await clearAllCandles();
            // Clear SQLite cache via API
            try {
                await fetch('/api/sqlite/clear', { method: 'POST' });
            } catch (e) {
                console.warn('Failed to clear SQLite cache:', e);
            }
            // Reload current data
            await dataManager.loadData();
            uiManager.showToast('Cache cleared and data reloaded', 'success');
            debugLogger.event('ui.cache.cleared');
        }
    });
}
```

## Implementation Order

1. **Phase 1: Core Logic**
   - Add `hourAlignmentMode` setting to `BacktestSettingsData` interface
   - Add default value to `DEFAULT_BACKTEST_SETTINGS`
   - Modify `resampleOHLCV` function to accept alignment parameter
   - Update `fetchBinanceData` and `fetchBinanceDataWithLimit` to use alignment

2. **Phase 2: Integration**
   - Update `DataManager` to pass alignment mode to fetch functions
   - Add `getHourAlignmentMode()` method to DataManager

3. **Phase 3: UI**
   - Add Hour Alignment section to settings HTML
   - Add handlers for alignment select and cache clear button
   - Wire up settings persistence

4. **Phase 4: Testing**
   - Test with 2H timeframe on even alignment (default)
   - Test with 2H timeframe on odd alignment
   - Verify cache behavior
   - Test with other timeframes (1H, 4H, etc.) to ensure no regression

## Affected Subsystems

- **Settings System**: New setting added to backtest settings
- **Data Pipeline**: Resampling and fetching logic modified
- **UI**: New controls in settings tab
- **Caching**: Cache alignment depends on setting at fetch time

## Backward Compatibility

- Default value is 'even', maintaining current behavior
- Existing saved configs will use 'even' as default (need to handle missing key)
- No breaking changes to existing functionality

## Edge Cases & Considerations

1. **Cached Data**: Data cached with one alignment won't automatically switch. Users must clear cache.
2. **Other Timeframes**: The offset only applies to multi-hour intervals (2H, 4H, 6H, 8H, 12H)
3. **Bybit Provider**: Should also be updated for consistency
4. **Mock Data**: Should respect alignment mode for testing
5. **Live Streaming**: Real-time bars should follow the same alignment

## Future Enhancements

- Per-symbol alignment settings
- Custom hour offset (not just 1 hour)
- Visual indicator of current alignment on chart
- Cache versioning to auto-invalidate on alignment change

## Validation Commands

After implementation, run:
```bash
npm run typecheck
npm run test
```

## Files to Modify

1. `lib/settings-manager.ts` - Add setting
2. `lib/strategies/resample-utils.ts` - Modify resampling logic
3. `lib/dataProviders/binance.ts` - Update fetch functions
4. `lib/dataProviders/bybit.ts` - Update fetch functions (for consistency)
5. `lib/data-manager.ts` - Pass alignment through data pipeline
6. `html-partials/tab-settings.html` - Add UI controls
7. `lib/handlers/settings-handlers.ts` - Add event handlers
