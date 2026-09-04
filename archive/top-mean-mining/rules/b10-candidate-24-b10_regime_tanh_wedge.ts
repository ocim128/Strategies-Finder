export default (cand, event) => cand.score + 0.18 * Math.tanh(4 * (cand.breadth - event.breadth)) * (cand.regime === event.regime ? 1 : -1);
