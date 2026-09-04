# TM-L1-C1 Final Report

## Close

- Campaign: `TM-L1-C1`
- L1 ledger: `sp500_top_mean_1788443592188_cgd3`
- Ledger fingerprint: `ec81193124e572237acdcd826c6fe688da3adf2156e2abac17052a1c1838b887`
- Disposition: `DONE-NO-PROMOTION`
- Contract evolution: v1.0 through v1.5
- Outcome batches: B1-B4 and B8-B10; ordinal 7 of 20
- Final counts: `N_D_surface=57`, `N_G=57`, `L1V=0/30`, `L2=unregistered`

The three-auditor close-the-books result is `57/57` outcome reproductions,
zero numerical mismatches, and unchanged ledger hashes. The campaign is
closed with no promoted selector.

## Durable findings

### Winner frontier mechanism

The incumbent winner's `activePairCount` was p25=41 and p50=44. The full
candidate population was p25=55, p50=60, p95=71, max=79. TOP_MEAN therefore
operates in a small-denominator winner frontier; inflated signed-vote ratios
are a plausible mechanism for the incumbent edge, but this campaign did not
confirm a safe replacement.

### Selection invariance

Every strictly increasing `g_event(score)` reproduced the incumbent on 568/568
events. Shrinkage variants were empirically invariant as well. Event-only
terms cannot reorder candidates within an event, so they cannot create a
selection edge without an additional candidate-specific mechanism.

### Certification gap

Three distinct lead behaviors remained visible: bear-regime coverage, support
deficit, and confirmation premium. Q29 and Q31 are selection twins and count
as one behavior. Their B8 lead means were +0.56 to +0.93pp with positive
dominant-exclusion diagnostics, but the 568-event evidence did not certify a
promotable lead across a fresh batch.

| behavior | B8 evidence | fresh B9 evidence |
| --- | --- | --- |
| bear coverage (Q29) | +0.93pp, CI95 [+0.05pp,+2.18pp] | +0.81pp, CI95 [+0.00pp,+2.00pp] |
| bear dual support (Q31, twin) | +0.93pp, CI95 [+0.05pp,+2.18pp] | +0.81pp, CI95 [+0.00pp,+2.00pp] |
| support deficit (Q32) | +0.74pp, CI95 [+0.41pp,+1.14pp] | -0.51pp, CI95 [-4.58pp,+2.63pp] |
| confirmation premium (Q35) | +0.56pp, CI95 [+0.13pp,+1.07pp] | +0.74pp, CI95 [-0.08pp,+1.76pp] |

The B9 corroboration means did not supply the required positive CI lower bound
on the 568-event surface, so the apparent gains remain discovery evidence.

### Degeneracy screen and exhaustion scope

The causal ZERO/THIN/MATERIAL screen rejected roughly 52-54% of the explored
surface at zero outcome cost where the batch screens were measured. The
amplitude laws remain: sub-±10% tilts are presumed THIN; useful boundaries are
in the 41-55 winner frontier; strong two-sided scales and joint gates are
MATERIAL candidates.

B10 was ten-for-ten `WORSE`. The single-transform and joint-gate space under
the frozen causal grammar was swept. This is local exhaustion, not idea-space
exhaustion; 144/201 discovery evaluations remained unspent by design.

## Lead disposition

The three counted behaviors were:

1. Q29 + Q31: bear-regime coverage floor; identical selected assets on 568/568
   events, counted once as selection twins.
2. Q32: support-deficit ranking.
3. Q35: confirmation premium.

All three are recorded and ineligible for promotion in TM-L1-C1. A successor
may use only fresh hypotheses and fresh gates; it inherits no evidence from
these leads.

## Deviations and containment

| deviation | containment and overclaim boundary |
| --- | --- |
| B2 used pool10/final4 | Preserved as immutable history and excluded from later claims; it is not a compliant ten-finalist batch. |
| B3 included identity Q20; Q16 was declared `>=41` but ran `>=52` | Identity was retired and the threshold drift was retained as a historical deviation; neither supports causal promotion. |
| B6 contained a malformed ledger hash | The malformed record remains immutable and its batch remains quarantined; no ledger conclusion is based on it. |
| B8 had four `||`-truncated pool registrations | X5 records the four affected candidates; no finalist or outcome was affected, and the legacy v1 pool digest is preserved. |
| B9/B10 registration-before-outcome order is attested by F4 `audit=PASS` and append-only order | The order is not independently provable from git because each batch was captured in a single commit; the report does not claim stronger provenance. |
| B10 had 106 duplicate S3 appends | v1.5 audit collapses byte-identical duplicates for screening counts; no duplicate is treated as additional discovery evidence. |

## Tooling fixes

- The audit now derives outcome ordinals from the first `I2` appearance of each
  distinct outcome-bearing batch. B8 resolves to 5, B9 to 6, and B10 to 7.
- The rule checker now supports the explicit `--allow-legacy-source` flag for
  historical pipe-containing rule replay. The default pipe rejection is
  unchanged, and B9-or-later campaign audit grammar still rejects U+007C.

## Final hashes

The frozen L1 ledger contains seven files:

| file | SHA-256 |
| --- | --- |
| `candidate-outcomes.jsonl` | `9bd76abb0940329c0aa919ee3c5bde33e477959ca5aa9daa836076b9c97bfbe9` |
| `events-annual-2025.jsonl` | `e9893d16168ccbf23a2eec7c65c504a4d577e1c6b68c4da215043b04c039d1d9` |
| `events-annual-2026.jsonl` | `d33d3e4c9f840cd11e5ad426dbf429555bd45998b6ecc7d7f8de58390eb18782` |
| `events-full.jsonl` | `877355d9edc12e8a0d9a1587ec7f88cf244d0cf1c51d887535645aec5592fdba` |
| `meta.json` | `96dca377e3f047b3ffec58dff717e628af840e5e751474ce079d480935e6a388` |
| `pool-snapshots.jsonl` | `1aa4f9dc854125154ca17ece117761149bfb9dd1ed02c919d2a2b6f02c4e9f67` |
| `report.txt` | `83f3e61b3c38b8ecb845bc8f7f1fa4fd8991f727adcf00620a41819535cdc1e5` |

- Idea-log SHA-256 at closure: `44aa2dd28dd56153c8169ec7ddc1b992bb8af1756191c6d8ec3b3b1a5acda4e8`
- Total rule files: 304

## Successor guidance

A successor campaign `TM-?-C1` must introduce genuinely new causal features,
such as trailing per-asset selection statistics from prior events only, vote
momentum, or time-since-last-picked under the anti-leakage v1.4 contract. It
must register before outcomes, rewrite the prompt with a new feature list,
calibration, campaign ID, and family space, and must not reuse this prompt
file. The three behaviors above should be tested as fresh hypotheses with more
statistical power, not inherited as evidence. The TM-L1 ledger is permanently
read-only.
