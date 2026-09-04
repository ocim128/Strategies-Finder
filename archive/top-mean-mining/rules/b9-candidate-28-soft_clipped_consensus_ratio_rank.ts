export default (cand, event) => Math.min(0.85, cand.score) + 0.005 * cand.signedVotes;
