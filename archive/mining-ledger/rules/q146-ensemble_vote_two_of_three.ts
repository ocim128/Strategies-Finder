export default (row) => (row.feat_entryRangePosition > 100) + (row.feat_return20 < -5) + (row.feat_pairTradesPrior >= 30) >= 2;
