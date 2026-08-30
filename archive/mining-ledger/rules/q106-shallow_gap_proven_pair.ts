export default (row) => row.feat_gapPct > -1.4 && row.feat_pairWinRatePrior != null && row.feat_pairWinRatePrior >= 0.5;
