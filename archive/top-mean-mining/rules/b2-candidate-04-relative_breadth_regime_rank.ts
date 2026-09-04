export default (cand, event) => cand.score * (1 + 2.5 * Math.pow(Math.abs(cand.breadth - event.breadth), 1.5)) * (cand.regime === event.regime ? 1.06 : 0.94);
