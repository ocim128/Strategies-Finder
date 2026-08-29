export default (row) => row.feat_entryRangePosition > 105 && row.feat_pairWinRatePrior !== null && row.feat_pairTradesPrior >= 5 && row.feat_pairWinRatePrior >= 0.55;
