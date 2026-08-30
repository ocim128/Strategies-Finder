export default (row) => row.feat_pairWinRatePrior != null && Math.abs(row.feat_pairWinRatePrior - 0.5) * Math.sqrt(row.feat_pairTradesPrior) > 1;
