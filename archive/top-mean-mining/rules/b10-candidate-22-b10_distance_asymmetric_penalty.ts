export default (cand, event) => cand.score * (1 - 1.5 * (cand.regime === event.regime ? 1 : -1) * Math.pow(cand.breadth - event.breadth, 2));
