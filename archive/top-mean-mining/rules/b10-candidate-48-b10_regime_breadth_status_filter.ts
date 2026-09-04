export default (cand, event) => cand.regime === event.regime ? cand.breadth >= 0.68 : cand.breadth <= 0.72 && cand.shortEligible;
