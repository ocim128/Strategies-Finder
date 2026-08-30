export default (row) => row.feat_atrPct < 2 && row.feat_pairTradesPrior >= 30 && row.feat_gapPct > -2;
