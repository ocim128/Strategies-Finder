# Pair Combiner Quality Improvements - Task Breakdown

## Planning Phase
- [x] Review existing Pair Combiner implementation
- [x] Identify quality improvement areas
- [/] Create improvement implementation plan
- [ ] Get user approval on plan

## Implementation Phase (After Approval)

### Phase 1: Algorithm Enhancements
- [ ] **Wavelet Types**: Implement Daubechies-4 and Coiflet-2 wavelets (currently stub)
- [ ] **Transfer Entropy**: Add multi-step history support (historyLength > 1)
- [ ] **Copula**: Add rolling window visualization data output
- [ ] **Bootstrap Significance**: Add statistical testing for transfer entropy

### Phase 2: Chart Visualization
- [ ] Add secondary pair overlay on main chart
- [ ] Add spread/ratio sub-chart visualization
- [ ] Display wavelet smoothed spread line
- [ ] Highlight divergence zones

### Phase 3: Input Validation & Error Handling
- [ ] Minimum bar count validation before analysis
- [ ] Cross-provider timestamp alignment warnings
- [ ] Graceful handling of sparse data
- [ ] Loading states and progress feedback

### Phase 4: Test Coverage
- [ ] Add edge case tests (empty data, single bar, NaN values)
- [ ] Add correlation boundary tests (perfect +1/-1)
- [ ] Add asymmetric TE tests with known leader
- [ ] Add wavelet energy conservation tests

### Phase 5: UX Polish
- [ ] Add tooltips explaining each metric
- [ ] Color-code opportunity scores (green/yellow/red)
- [ ] Add "Export Results" functionality
- [ ] Improve notes section with actionable insights

### Phase 6: Performance
- [ ] Web Worker for heavy computation
- [ ] Progress indicators during analysis
- [ ] Caching for repeated analyses

## Verification Phase
- [ ] Run all unit tests
- [ ] Manual testing with diverse pair combinations
- [ ] Verify chart visualizations render correctly
