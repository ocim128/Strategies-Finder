export default (cand, event) => cand.score * (event.hour >= 18 ? (cand.breadth >= 0.65 ? 1.15 : 0.88) : 1.0);
