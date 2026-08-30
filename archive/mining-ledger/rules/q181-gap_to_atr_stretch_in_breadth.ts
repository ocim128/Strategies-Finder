export default (row) => row.feat_candidatesAtTime >= 25 && row.feat_atrPct >= 1.8 && row.feat_atrPct <= 3.5 && Math.abs(row.feat_gapPct) >= 0.8 * row.feat_atrPct;
