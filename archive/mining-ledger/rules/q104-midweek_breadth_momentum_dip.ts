export default (row) => (row.feat_dow === 2 || row.feat_dow === 3) && row.feat_candidatesAtTime >= 25 && row.feat_return20 >= -3.0 && row.feat_return20 <= -0.5;
