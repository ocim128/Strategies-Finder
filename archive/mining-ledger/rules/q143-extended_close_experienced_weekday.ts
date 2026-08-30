export default (row) => row.feat_entryRangePosition > 100 && row.feat_pairTradesPrior >= 5 && (row.feat_dow === 2 || row.feat_dow === 4);
