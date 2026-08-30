export default (row) => row.feat_pairWinRatePrior !== null && row.feat_pairTradesPrior >= 8 && row.feat_pairWinRatePrior <= 0.45 && row.feat_atrPct <= 1.2;
