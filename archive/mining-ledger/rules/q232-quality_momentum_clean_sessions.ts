export default (row) => row.feat_return20 > 4 && row.feat_pairWinRatePrior != null && row.feat_pairWinRatePrior >= 0.5 && row.feat_dow >= 2 && row.feat_dow <= 4;
