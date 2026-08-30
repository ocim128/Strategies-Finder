export default (row) => ((row.feat_entryRangePosition > 100 ? 1 : 0) + (row.feat_return20 > 0 ? 1 : 0) + (row.feat_gapPct > -1.4 ? 1 : 0) + (row.feat_pairWinRatePrior >= 0.5 ? 1 : 0)) >= 3;
