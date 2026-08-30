export default (row) => row.feat_dow === 1 && row.feat_gapPct <= -1.5 && row.feat_gapPct >= -3.5 && row.feat_entryRangePosition >= 70;
