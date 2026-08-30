export default (row) => row.feat_pairWinRatePrior != null && row.feat_pairWinRatePrior < 0.45 && row.feat_dow >= 4;
