const fs = require('fs');

function replaceInFile(file, replacements) {
    let content = fs.readFileSync(file, 'utf8');
    for (const [oldStr, newStr] of replacements) {
        content = content.split(oldStr).join(newStr);
    }
    fs.writeFileSync(file, content);
}

replaceInFile('lib/strategies/lib/overlapping_streak_phi_trap.ts', [
    ['if (efficiency === null || trailingHigh === null || trailingLow === null) return null;\n      \n      const prevDownStreak = downStreak[i - 1];\n      const prevUpStreak = upStreak[i - 1];\n      const trailingHigh = extremes.highest[i - 1];\n      const trailingLow = extremes.lowest[i - 1];',
    'const trailingHigh = extremes.highest[i - 1];\n      const trailingLow = extremes.lowest[i - 1];\n      if (efficiency === null || trailingHigh === null || trailingLow === null) return null;\n      \n      const prevDownStreak = downStreak[i - 1];\n      const prevUpStreak = upStreak[i - 1];']
]);

let pivotContent = fs.readFileSync('lib/strategies/lib/pivot_buffer_phi_cascade.ts', 'utf8');
pivotContent = pivotContent.replace(
    'pivots.forEach(p => { if(p.direction === -1) pivotHighs[p.index] = p.price; else pivotLows[p.index] = p.price; });',
    'pivots.forEach(p => { if(p.isHigh) pivotHighs[p.index] = p.price; else pivotLows[p.index] = p.price; });'
);
fs.writeFileSync('lib/strategies/lib/pivot_buffer_phi_cascade.ts', pivotContent);
