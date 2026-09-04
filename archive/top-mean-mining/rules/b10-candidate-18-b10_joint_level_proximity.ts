export default (cand, event) => 1 - Math.abs((cand.breadth + cand.score) - (event.breadth + 0.95));
