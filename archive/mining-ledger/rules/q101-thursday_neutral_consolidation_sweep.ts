export default (row) => row.feat_dow === 4 && Math.abs(row.feat_return20) <= 2.0 && row.feat_atrPct >= 1.5 && row.feat_atrPct <= 2.8;
