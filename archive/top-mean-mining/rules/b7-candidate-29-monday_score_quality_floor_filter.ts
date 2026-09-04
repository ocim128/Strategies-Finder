export default (cand, event) => event.dow === 1 ? cand.score >= 0.80 : true;
