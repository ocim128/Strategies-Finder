export default (cand, event) => cand.score * (1 + 0.30 * (cand.breadth - event.breadth));
