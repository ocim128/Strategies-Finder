export default (cand, event) => cand.score * (0.5 + 0.5 * cand.activePairCount / 79);
