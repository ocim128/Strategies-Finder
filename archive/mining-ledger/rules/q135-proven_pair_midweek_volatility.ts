export default (row) => row.feat_pairWinRatePrior !== null && row.feat_pairTradesPrior >= 5 && row.feat_pairWinRatePrior >= 0.5 && row.feat_atrPct >= 3 && (row.feat_dow === 2 || row.feat_dow === 4);
