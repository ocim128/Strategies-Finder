const fs = require('fs');

function replaceInFile(file, replacements) {
    let content = fs.readFileSync(file, 'utf8');
    for (const [oldStr, newStr] of replacements) {
        content = content.split(oldStr).join(newStr);
    }
    fs.writeFileSync(file, content);
}

replaceInFile('lib/strategies/lib/boredom_entropy_phi_ignition.ts', [
    ['extremes.highs', 'extremes.highest'],
    ['extremes.lows', 'extremes.lowest']
]);

replaceInFile('lib/strategies/lib/micro_breakout_phi_fakeout.ts', [
    ['macroExtremes.highs', 'macroExtremes.highest'],
    ['macroExtremes.lows', 'macroExtremes.lowest']
]);

replaceInFile('lib/strategies/lib/overlapping_streak_phi_trap.ts', [
    ['extremes.highs', 'extremes.highest'],
    ['extremes.lows', 'extremes.lowest'],
    [', getOpens', ''] // Remove unused import
]);

replaceInFile('lib/strategies/lib/vwap_stretch_phi_exhaustion.ts', [
    ['extremes.highs', 'extremes.highest'],
    ['extremes.lows', 'extremes.lowest']
]);

replaceInFile('lib/strategies/lib/euphoria_volume_phi_divergence.ts', [
    ['const volumesNull = volumes.map(v => v);', 'const volumesClean = volumes.map(v => v === null ? 0 : v);'],
    ['buildRollingCorrelation(volumesNull, roc, p.corr_lookback)', 'buildRollingCorrelation(volumesClean, roc.map(r => r === null ? 0 : r), p.corr_lookback)']
]);

replaceInFile('lib/strategies/lib/fomo_momentum_phi_decay.ts', [
    ['buildInitiativePressureSeries(cleanData)', 'buildInitiativePressureSeries(cleanData, 1)'],
    ['buildCumulativeDecaySum(initiative, p.phi_decay)', 'buildCumulativeDecaySum(initiative.map(v => v === null ? 0 : v), p.phi_decay)']
]);

replaceInFile('lib/strategies/lib/retail_gap_phi_exhaustion.ts', [
    ['buildInitiativePressureSeries(cleanData)', 'buildInitiativePressureSeries(cleanData, 1)']
]);

// pivot_buffer_phi_cascade.ts: detectPivots returns an array of pivots, not { pivotHighs, pivotLows }
let pivotContent = fs.readFileSync('lib/strategies/lib/pivot_buffer_phi_cascade.ts', 'utf8');
pivotContent = pivotContent.replace(
    'const { pivotHighs, pivotLows } = detectPivots(cleanData, p.pivot_lookback, p.pivot_lookback);',
    'const pivots = detectPivots(cleanData, p.pivot_lookback);\n    const pivotHighs: (number|undefined)[] = [];\n    const pivotLows: (number|undefined)[] = [];\n    pivots.forEach(p => { if(p.type === "high") pivotHighs[p.index] = p.price; else pivotLows[p.index] = p.price; });'
);
fs.writeFileSync('lib/strategies/lib/pivot_buffer_phi_cascade.ts', pivotContent);

console.log("Fixes applied.");