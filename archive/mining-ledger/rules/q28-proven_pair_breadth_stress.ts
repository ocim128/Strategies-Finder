export default (row) => row.feat_pairWinRatePrior !== null && row.feat_pairTradesPrior >= 8 && row.feat_pairWinRatePrior >= 0.50 && row.feat_candidatesAtTime >= 25;
