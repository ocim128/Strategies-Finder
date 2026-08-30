export default (row) => row.feat_entryRangePosition < 60 && row.feat_pairWinRatePrior != null && row.feat_pairWinRatePrior >= 0.5;
