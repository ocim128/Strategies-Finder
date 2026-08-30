export default (row) => row.feat_dow >= 2 && row.feat_dow <= 4 && Math.abs(row.feat_return20) <= 1.5;
