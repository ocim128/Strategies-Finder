export default (cand, event) => 1 - Math.abs(cand.activePairCount - (cand.shortEligible ? 48 : 54)) / 20;
