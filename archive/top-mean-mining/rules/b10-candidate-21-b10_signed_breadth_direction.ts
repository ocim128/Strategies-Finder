export default (cand, event) => cand.score * (1 + 0.3 * Math.sign(cand.breadth - event.breadth) * (cand.regime === event.regime ? 1 : -1));
