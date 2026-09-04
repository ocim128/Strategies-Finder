export default (cand, event) => cand.score * (1 + (cand.regime === event.regime ? 1 : -1) * Math.tanh(5 * (cand.breadth - event.breadth)));
