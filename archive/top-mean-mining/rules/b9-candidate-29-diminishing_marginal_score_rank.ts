export default (cand, event) => Math.sqrt(cand.score) * Math.log(cand.signedVotes + 2);
