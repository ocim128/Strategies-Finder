export default (cand, event) => cand.score * Math.exp(-Math.pow((cand.breadth - (event.dow === 3 ? 0.58 : 0.74)) / 0.10, 2));
