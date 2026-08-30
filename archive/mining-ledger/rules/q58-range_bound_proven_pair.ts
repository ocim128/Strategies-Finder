export default (row) => Math.abs(row.feat_return20) < 2 && row.feat_pairWinRatePrior != null && row.feat_pairWinRatePrior >= 0.55;
