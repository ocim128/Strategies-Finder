export default (row) => row.feat_atrPct > 0.5 && row.feat_gapPct / row.feat_atrPct < -1 && row.feat_return20 / row.feat_atrPct < -4;
