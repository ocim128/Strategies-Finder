const fs = require('fs');

function replaceInFile(file, replacements) {
    let content = fs.readFileSync(file, 'utf8');
    for (const [oldStr, newStr] of replacements) {
        content = content.split(oldStr).join(newStr);
    }
    fs.writeFileSync(file, content);
}

replaceInFile('lib/strategies/lib/boredom_entropy_phi_ignition.ts', [
    ['if (ent === null || eff === null) return null;', 'if (ent === null || eff === null || trailingHigh === null || trailingLow === null) return null;']
]);

replaceInFile('lib/strategies/lib/micro_breakout_phi_fakeout.ts', [
    ['const spread = prevHigh - prevLow;', 'if (prevHigh === null || prevLow === null) return null;\n      const spread = prevHigh - prevLow;']
]);

replaceInFile('lib/strategies/lib/overlapping_streak_phi_trap.ts', [
    ['import {\n  createBuySignal,\n  createSellSignal,\n  createSignalLoop,\n  ensureCleanData,\n  getCloses,\n  getOpens\n} from "../strategy-helpers";', 'import {\n  createBuySignal,\n  createSellSignal,\n  createSignalLoop,\n  ensureCleanData,\n  getCloses\n} from "../strategy-helpers";'],
    ['if (efficiency === null) return null;', 'if (efficiency === null || trailingHigh === null || trailingLow === null) return null;']
]);

replaceInFile('lib/strategies/lib/vwap_stretch_phi_exhaustion.ts', [
    ['const spread = extremes.highest[i] - extremes.lowest[i];', 'const high = extremes.highest[i];\n      const low = extremes.lowest[i];\n      if (high === null || low === null) return null;\n      const spread = high - low;']
]);

// pivot_buffer_phi_cascade.ts
let pivotContent = fs.readFileSync('lib/strategies/lib/pivot_buffer_phi_cascade.ts', 'utf8');
pivotContent = pivotContent.replace(
    'const pivots = detectPivots(cleanData, p.pivot_lookback);\n    const pivotHighs: (number|undefined)[] = [];\n    const pivotLows: (number|undefined)[] = [];\n    pivots.forEach(p => { if(p.type === "high") pivotHighs[p.index] = p.price; else pivotLows[p.index] = p.price; });',
    'const pivots = detectPivots(cleanData, { depth: p.pivot_lookback, deviationThreshold: 0, extremaMode: "strict" });\n    const pivotHighs: (number|undefined)[] = [];\n    const pivotLows: (number|undefined)[] = [];\n    pivots.forEach(p => { if(p.direction === -1) pivotHighs[p.index] = p.price; else pivotLows[p.index] = p.price; });'
);
fs.writeFileSync('lib/strategies/lib/pivot_buffer_phi_cascade.ts', pivotContent);

console.log("Fixes phase 2 applied.");
