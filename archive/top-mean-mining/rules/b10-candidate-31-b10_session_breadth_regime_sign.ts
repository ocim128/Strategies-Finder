export default (cand, event) => cand.score * (1 + 0.16 * (event.hour < 12 ? 1 : -1) * (cand.breadth >= event.breadth ? 1 : -1) * (cand.regime === event.regime ? 1 : -1));
