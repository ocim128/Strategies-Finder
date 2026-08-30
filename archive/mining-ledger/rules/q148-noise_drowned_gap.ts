export default (row) => row.feat_atrPct > 0.5 && row.feat_gapPct > -0.3 * row.feat_atrPct;
