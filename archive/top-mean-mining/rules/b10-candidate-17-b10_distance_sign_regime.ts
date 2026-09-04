export default (cand, event) => cand.score * (1 + 0.5 * Math.pow(cand.breadth - event.breadth, 2) * (cand.regime === event.regime ? -1 : 1));
