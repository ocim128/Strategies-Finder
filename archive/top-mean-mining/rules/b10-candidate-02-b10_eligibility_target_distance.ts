export default (cand, event) => 1 - Math.abs(cand.score - (cand.shortEligible ? 0.58 : 0.78));
