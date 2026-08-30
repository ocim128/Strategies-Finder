export default (row) => row.feat_pairWinRatePrior != null && row.feat_pairWinRatePrior >= 0.55 && (row.feat_dow === 1 || row.feat_dow === 2);
