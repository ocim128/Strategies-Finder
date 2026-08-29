// H1 "no-chase": long entries only when the signal bar's close is within or below
// the prior bar's range (<= 100%). Closing above the prior high = chasing an
// extended move. Causal: uses only the entry-time feature.
export default (row) => row.feat_entryRangePosition !== null && row.feat_entryRangePosition <= 100;
