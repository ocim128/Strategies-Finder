export default (row) => (row.feat_pairTradesPrior >= 40 && row.feat_gapPct > -2) || (row.feat_pairTradesPrior < 40 && row.feat_gapPct < -3);
