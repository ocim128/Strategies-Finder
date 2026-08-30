export default (row) => row.feat_pairWinRatePrior != null && row.feat_pairWinRatePrior >= 0.6 && row.feat_candidatesAtTime >= 50;
