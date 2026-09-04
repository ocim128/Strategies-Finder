export default (cand, event) => cand.activePairCount <= 45 ? cand.breadth >= event.breadth : cand.breadth <= event.breadth && cand.shortEligible;
