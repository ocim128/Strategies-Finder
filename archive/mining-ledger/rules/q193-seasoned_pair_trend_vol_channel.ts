export default (row) => row.feat_pairTradesPrior >= 6 && row.feat_atrPct >= 2.0 && row.feat_atrPct <= 3.2 && row.feat_return20 >= 0.8 && row.feat_return20 <= 3.5;
