export default (cand, event) => cand.breadth >= event.breadth ? cand.ema200Above && cand.score >= 0.30 : cand.shortEligible && cand.score >= 0.22;
