export default (cand, event) => cand.shortEligible ? cand.score >= 0.52 && cand.ema200Above : cand.score >= 0.36 && !cand.ema200Above;
