export default (row: { feat_atrPct: number | null }): boolean => row.feat_atrPct !== null && row.feat_atrPct > 1;
