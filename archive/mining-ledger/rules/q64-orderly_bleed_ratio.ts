export default (row) => row.feat_return20 < 0 && row.feat_atrPct > 0.5 && row.feat_return20 / row.feat_atrPct > -4;
