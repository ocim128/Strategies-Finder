export default (cand, event) => cand.score * (cand.shortEligible ? 1 : 0.85);
