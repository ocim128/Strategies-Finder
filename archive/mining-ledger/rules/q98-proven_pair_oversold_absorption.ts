export default (row) => row.feat_pairWinRatePrior !== null && row.feat_pairTradesPrior >= 7 && row.feat_pairWinRatePrior >= 0.48 && row.feat_return20 <= -3.0 && row.feat_entryRangePosition >= 80;
