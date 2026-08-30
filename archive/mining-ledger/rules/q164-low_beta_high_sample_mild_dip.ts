export default (row) => row.feat_pairTradesPrior >= 10 && row.feat_atrPct <= 2.2 && row.feat_return20 >= -2.5 && row.feat_return20 <= -0.8;
