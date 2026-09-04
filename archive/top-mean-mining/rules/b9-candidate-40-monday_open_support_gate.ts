export default (cand, event) => event.dow === 1 ? cand.activePairCount >= 46 : true;
