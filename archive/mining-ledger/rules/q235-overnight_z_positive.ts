export default (row) => row.feat_atrPct > 0.5 && row.feat_gapPct / row.feat_atrPct > 0.25;
