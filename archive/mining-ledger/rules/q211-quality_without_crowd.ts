export default (row) => row.feat_pairWinRatePrior != null && row.feat_pairWinRatePrior >= 0.55 && row.feat_candidatesAtTime >= 18 && row.feat_candidatesAtTime <= 40;
