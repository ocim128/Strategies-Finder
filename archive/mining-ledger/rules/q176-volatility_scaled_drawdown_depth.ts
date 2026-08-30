export default (row) => row.feat_atrPct >= 2.0 && row.feat_atrPct <= 3.8 && row.feat_return20 <= -1.5 * row.feat_atrPct && row.feat_return20 >= -3.5 * row.feat_atrPct;
