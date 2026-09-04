export default (cand, event) => cand.score + 3 * Math.pow(cand.breadth - event.breadth, 3);
