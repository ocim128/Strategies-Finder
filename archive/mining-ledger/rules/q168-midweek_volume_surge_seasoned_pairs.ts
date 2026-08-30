export default (row) => (row.feat_dow === 3 || row.feat_dow === 4) && row.feat_candidatesAtTime >= 35 && row.feat_pairTradesPrior >= 8;
