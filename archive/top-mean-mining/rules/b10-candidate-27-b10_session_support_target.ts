export default (cand, event) => cand.score * Math.exp(-Math.pow((cand.signedVotes - (event.hour < 12 ? 18 : 26)) / 7, 2));
