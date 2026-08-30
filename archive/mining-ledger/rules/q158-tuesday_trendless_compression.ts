export default (row) => row.feat_dow === 2 && Math.abs(row.feat_return20) <= 1.2 && row.feat_atrPct <= 2.2;
