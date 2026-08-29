export default (row) => row.feat_pairWinRatePrior !== null && row.feat_pairTradesPrior >= 5 && row.feat_pairWinRatePrior <= 0.45 && row.feat_gapPct >= 0.2;
