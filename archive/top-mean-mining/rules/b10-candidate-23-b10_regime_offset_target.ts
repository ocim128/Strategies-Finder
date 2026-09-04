export default (cand, event) => cand.score * Math.exp(-Math.pow((cand.breadth - (event.breadth + (cand.regime === event.regime ? -0.10 : 0.10))) / 0.08, 2));
