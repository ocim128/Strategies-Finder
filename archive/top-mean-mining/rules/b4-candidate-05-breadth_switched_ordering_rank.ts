export default (cand, event) => event.breadth > 0.71 ? cand.signedVotes : cand.score;
