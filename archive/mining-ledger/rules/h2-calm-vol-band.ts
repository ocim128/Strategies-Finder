// H2 "calm volatility band": only enter when the ratio's ATR% at the signal bar
// is in a normal band - above dead-pair flatness (1%) and below panic regimes (5%).
// Causal: ATR(14) is computed from bars at or before the signal bar.
export default (row) => row.feat_atrPct !== null && row.feat_atrPct > 1 && row.feat_atrPct < 5;
