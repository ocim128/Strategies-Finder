export default (row) => row.feat_dow === 1 && row.feat_candidatesAtTime >= 30 && row.feat_gapPct >= -1.5 && row.feat_gapPct <= -0.3;
