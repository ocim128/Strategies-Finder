export default (row) => row.feat_gapPct < -0.15 && row.feat_hour >= 12 && row.feat_hour <= 15;
