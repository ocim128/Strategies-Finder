export default (row) => row.feat_pairWinRatePrior != null && Math.abs(row.feat_pairWinRatePrior - 0.5) >= 0.15 && row.feat_candidatesAtTime >= 40;
