export default (row) => row.feat_gapPct < -3 && row.feat_pairTradesPrior >= 5 && (row.feat_dow === 1 || row.feat_dow === 5);
