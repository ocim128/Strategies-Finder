export default (row) => (row.feat_dow === 3 || row.feat_dow === 4) && row.feat_candidatesAtTime >= 20 && row.feat_candidatesAtTime <= 45 && row.feat_atrPct >= 1.2 && row.feat_atrPct <= 2.2;
