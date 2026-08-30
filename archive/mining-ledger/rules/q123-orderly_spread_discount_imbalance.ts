export default (row) => Math.abs(row.feat_return20) <= 1.8 && row.feat_gapPct >= -1.6 && row.feat_gapPct <= -0.5;
