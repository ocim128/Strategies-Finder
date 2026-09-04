export default (cand, event) => event.dow >= 4 ? cand.signedVotes : cand.score;
