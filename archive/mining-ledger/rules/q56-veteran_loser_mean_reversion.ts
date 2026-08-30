export default (row) => row.feat_pairTradesPrior >= 40 && row.feat_pairWinRatePrior != null && row.feat_pairWinRatePrior < 0.35;
