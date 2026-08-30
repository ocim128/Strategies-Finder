export default (row) => row.feat_return20 > 5 && row.feat_pairWinRatePrior != null && row.feat_pairWinRatePrior >= 0.55;
