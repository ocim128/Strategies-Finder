export default (cand, event) => cand.activePairCount >= 48 ? cand.shortEligible : cand.ema200Above;
