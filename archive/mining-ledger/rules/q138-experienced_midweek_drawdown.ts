export default (row) => row.feat_pairTradesPrior >= 8 && row.feat_return20 <= -1.5 && (row.feat_dow === 2 || row.feat_dow === 3 || row.feat_dow === 4);
