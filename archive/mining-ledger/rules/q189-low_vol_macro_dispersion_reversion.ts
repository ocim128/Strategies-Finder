export default (row) => row.feat_candidatesAtTime >= 35 && row.feat_atrPct <= 1.9 && Math.abs(row.feat_return20) <= 1.5;
