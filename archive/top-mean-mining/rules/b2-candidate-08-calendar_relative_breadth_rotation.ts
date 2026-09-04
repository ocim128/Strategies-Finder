export default (cand, event) => cand.score * (1 + (event.dow === 1 || event.dow === 4 ? 0.14 : -0.06) * (cand.breadth >= event.breadth ? 1 : -1));
