export default (cand, event) => cand.score >= 0.58 ? cand.shortEligible === false : cand.ema200Above;
