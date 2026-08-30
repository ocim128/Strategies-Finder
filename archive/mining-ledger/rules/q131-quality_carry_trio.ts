export default (row) => row.feat_pairWinRatePrior != null && row.feat_pairWinRatePrior >= 0.5 && row.feat_return20 > 0 && row.feat_atrPct < 3;
