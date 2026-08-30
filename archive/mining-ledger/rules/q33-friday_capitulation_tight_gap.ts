export default (row) => row.feat_dow === 5 && row.feat_candidatesAtTime >= 35 && row.feat_gapPct >= -1.0 && row.feat_gapPct <= -0.1;
