export default (cand, event) => cand.score * (cand.regime === event.regime ? 1 - 0.4 * Math.abs(cand.breadth - event.breadth) : 1 + 0.4 * Math.abs(cand.breadth - event.breadth));
