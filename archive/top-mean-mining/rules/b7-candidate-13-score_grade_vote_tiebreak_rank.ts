export default (cand, event) => Math.floor(cand.score * 20) + 0.001 * cand.signedVotes;
