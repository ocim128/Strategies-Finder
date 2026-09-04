export default (cand, event) => cand.shortEligible ? cand.score <= 0.72 : cand.score >= 0.38;
