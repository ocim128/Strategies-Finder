export default (row) => row.feat_candidatesAtTime >= 6 && row.feat_atrPct <= 3 && (row.feat_dow === 1 || row.feat_dow === 5);
