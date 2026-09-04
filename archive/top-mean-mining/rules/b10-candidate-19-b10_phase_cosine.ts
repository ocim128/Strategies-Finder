export default (cand, event) => cand.score * (cand.regime === event.regime ? Math.cos((cand.breadth - event.breadth) * Math.PI) : 1 - 0.5 * Math.abs(cand.breadth - event.breadth));
