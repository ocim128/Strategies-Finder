export default (row) => row.feat_candidatesAtTime <= 5 && (row.feat_dow === 1 || row.feat_dow === 5);
