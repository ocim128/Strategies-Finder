export default (row) => row.feat_pairTradesPrior >= 10 && (row.feat_dow === 1 || row.feat_dow === 5);
