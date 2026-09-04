export default (cand, event) => cand.signedVotes >= 25 + 15 * Math.max(0, (event.breadth ?? 0.67) - 0.60);
