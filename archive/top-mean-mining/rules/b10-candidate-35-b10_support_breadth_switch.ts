export default (cand, event) => cand.signedVotes >= 18 ? cand.breadth <= 0.66 : cand.breadth >= 0.70;
