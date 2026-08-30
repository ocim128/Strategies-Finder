export default (row) => row.feat_candidatesAtTime >= 18 && row.feat_candidatesAtTime <= 60 && row.feat_pairWinRatePrior != null && row.feat_pairWinRatePrior >= 0.55;
