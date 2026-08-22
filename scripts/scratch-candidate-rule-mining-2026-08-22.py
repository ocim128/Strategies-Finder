"""Read-only AO archive audit for the 2026-08-22 candidate-rule brief.

This intentionally stays separate from the checked-in analyze-* tools.  It
parses the archived top-10 sort blocks, deduplicates their visible union pool,
selects greedy stride-spaced holdouts, and prints the statistics needed by the
research note.  Forward values are used only as targets/baselines.
"""

from __future__ import annotations

import argparse
import json
import math
import re
from collections import defaultdict
from itertools import combinations
from pathlib import Path
from statistics import median


BLOCK_RE = re.compile(
    r"^={80}\n"
    r"Timestamp: (?P<timestamp>[^\n]+)\n"
    r"Batch run id: (?P<batch>[^\n]+)\n"
    r"OOS holdout: (?P<holdout>\d+) bars\n"
    r"Archive sort: (?P<sort>[^\n]+)\n"
    r"(?:Archive baseline: (?P<baseline>[^\n]+)\n)?"
    r"={80}\n(?P<rows>[\s\S]*?)(?=\n={80}\n|$)",
    re.MULTILINE,
)
FILE_RE = re.compile(r"^oos-holdout-(\d+)-bars\.txt$")
PAIR_FILE_RE = re.compile(r"^oos-pair-summary-(\d+)-bars\.txt$")


def finite(value: object) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(float(value))


def candidate_key(row: dict) -> str:
    return "|".join(
        str(row.get(field, ""))
        for field in ("symbol", "strategyId", "candidateFingerprint")
    )


def target(row: dict, horizon: int) -> float | None:
    forward = row.get("forwardOosPerformance") or {}
    for item in forward.get("horizons", []) or []:
        if item.get("bars") == horizon and finite(item.get("pnlPercent")) and item.get("sampleSize", 1) > 0:
            return float(item["pnlPercent"])
    return None


def parse_dir(directory: Path) -> tuple[str, dict[int, dict[str, dict]], dict[int, set[str]]]:
    parsed: list[dict] = []
    for file in sorted(directory.iterdir()):
        match = FILE_RE.match(file.name)
        if not match:
            continue
        holdout = int(match.group(1))
        text = file.read_text(encoding="utf-8", errors="replace")
        for block in BLOCK_RE.finditer(text):
            try:
                rows = json.loads(block.group("rows"))
            except json.JSONDecodeError:
                continue
            baseline = None
            if block.group("baseline"):
                try:
                    baseline = json.loads(block.group("baseline"))
                except json.JSONDecodeError:
                    pass
            parsed.append({
                "timestamp": block.group("timestamp"),
                "batch": block.group("batch"),
                "holdout": holdout,
                "sort": block.group("sort"),
                "rows": rows,
                "baseline": baseline,
            })

    by_batch: dict[str, list[dict]] = defaultdict(list)
    for block in parsed:
        by_batch[block["batch"]].append(block)
    if not by_batch:
        raise RuntimeError(f"No parseable holdout blocks: {directory}")
    selected_batch, selected_blocks = max(
        by_batch.items(), key=lambda item: (len(item[1]), max(b["timestamp"] for b in item[1]))
    )
    latest: dict[tuple[int, str], dict] = {}
    for block in selected_blocks:
        key = (block["holdout"], block["sort"])
        if key not in latest or block["timestamp"] >= latest[key]["timestamp"]:
            latest[key] = block
    blocks: dict[int, dict[str, dict]] = defaultdict(dict)
    for (holdout, sort), block in latest.items():
        blocks[holdout][sort] = block
    pool_ids: dict[int, set[str]] = {}
    for holdout, by_sort in blocks.items():
        pool_ids[holdout] = {
            candidate_key(row)
            for block in by_sort.values()
            for row in block["rows"]
            if candidate_key(row) != "||"
        }
    return selected_batch, dict(blocks), pool_ids


def stride_holdouts(holdouts: list[int], stride: int, minimum: int, maximum: int) -> list[int]:
    selected: list[int] = []
    next_target = -math.inf
    for holdout in sorted(h for h in holdouts if minimum <= h <= maximum):
        if holdout >= next_target:
            selected.append(holdout)
            next_target = holdout + stride
    return selected


def mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else math.nan


def stats(values: list[float]) -> tuple[float, float, float]:
    return mean(values), median(values) if values else math.nan, (
        sum(value > 0 for value in values) / len(values) if values else math.nan
    )


def pool_for_holdout(by_sort: dict[str, dict]) -> dict[str, dict]:
    pool: dict[str, dict] = {}
    for block in by_sort.values():
        for row in block["rows"]:
            key = candidate_key(row)
            if key and key != "||":
                pool.setdefault(key, row)
    return pool


def cell_stats(blocks: dict[int, dict[str, dict]], holdouts: list[int], horizon: int, sort: str, top_k: int) -> tuple[float, float, float, int]:
    deltas: list[float] = []
    for holdout in holdouts:
        by_sort = blocks[holdout]
        pool = pool_for_holdout(by_sort)
        pool_values = [value for row in pool.values() if (value := target(row, horizon)) is not None]
        selected_block = by_sort.get(sort)
        if not selected_block or not pool_values:
            continue
        selected_values = [
            value for row in selected_block["rows"]
            if isinstance(row.get("rank"), int) and 1 <= row["rank"] <= top_k
            if (value := target(row, horizon)) is not None
        ]
        if selected_values:
            deltas.append(mean(selected_values) - mean(pool_values))
    return (*stats(deltas), len(deltas))


def pairwise_overlap(ids_by_run: dict[str, dict[int, set[str]]], holdouts: list[int]) -> tuple[float, float]:
    values: list[float] = []
    for left_name, right_name in combinations(sorted(ids_by_run), 2):
        for holdout in holdouts:
            left = ids_by_run[left_name].get(holdout, set())
            right = ids_by_run[right_name].get(holdout, set())
            union = left | right
            if union:
                values.append(len(left & right) / len(union))
    return mean(values), median(values) if values else math.nan


def top_pick_overlap(blocks_by_run: dict[str, dict[int, dict[str, dict]]], holdouts: list[int], sort: str, top_k: int) -> tuple[float, float]:
    values: list[float] = []
    for left_name, right_name in combinations(sorted(blocks_by_run), 2):
        for holdout in holdouts:
            left_block = blocks_by_run[left_name].get(holdout, {}).get(sort)
            right_block = blocks_by_run[right_name].get(holdout, {}).get(sort)
            if not left_block or not right_block:
                continue
            left = {candidate_key(row) for row in left_block["rows"] if row.get("rank", 0) <= top_k}
            right = {candidate_key(row) for row in right_block["rows"] if row.get("rank", 0) <= top_k}
            union = left | right
            if union:
                values.append(len(left & right) / len(union))
    return mean(values), median(values) if values else math.nan


def print_run(label: str, directory: Path, batch: str, blocks: dict[int, dict[str, dict]], pool_ids: dict[int, set[str]], stride: int, minimum: int, maximum: int, horizon: int) -> None:
    all_holdouts = sorted(blocks)
    selected = stride_holdouts(all_holdouts, stride, minimum, maximum)
    sizes = [len(pool_ids[h]) for h in selected]
    symbols = [
        len({row.get("symbol") for row in pool_for_holdout(blocks[h]).values() if row.get("symbol")})
        for h in selected
    ]
    sorts = sorted({sort for h in selected for sort in blocks[h]})
    print(f"RUN {label} | batch={batch} | files={len(all_holdouts)} | stride_windows={len(selected)} | range={selected[0] if selected else 'n/a'}..{selected[-1] if selected else 'n/a'}")
    print(f"POOL {label} | unique_candidates_per_file mean={mean(sizes):.1f} median={median(sizes):.1f} | distinct_symbols_per_file mean={mean(symbols):.1f} median={median(symbols):.1f}")
    print("CELL " + label + " | sort | K | windows | mean_delta | median_delta | positive_windows")
    for sort in ("profitFactor", "sharpeRatio", "expectancy", "totalTrades", "averageGain", "invertedWinRate", "run_default"):
        if sort not in sorts:
            continue
        for top_k in (1, 2, 3):
            avg, med, positive, count = cell_stats(blocks, selected, horizon, sort, top_k)
            print(f"CELL {label} | {sort} | {top_k} | {count} | {avg:+.4f}% | {med:+.4f}% | {positive * 100:.1f}%")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", action="append", nargs=2, metavar=("LABEL", "DIRECTORY"), required=True)
    parser.add_argument("--stride", type=int, default=12)
    parser.add_argument("--min-holdout", type=int, default=12)
    parser.add_argument("--max-holdout", type=int, default=300)
    parser.add_argument("--horizon", type=int, default=12)
    args = parser.parse_args()

    loaded: dict[str, tuple[str, dict[int, dict[str, dict]], dict[int, set[str]], Path]] = {}
    for label, raw_directory in args.label:
        directory = Path(raw_directory)
        batch, blocks, pool_ids = parse_dir(directory)
        loaded[label] = (batch, blocks, pool_ids, directory)
        print_run(label, directory, batch, blocks, pool_ids, args.stride, args.min_holdout, args.max_holdout, args.horizon)

    labels = sorted(loaded)
    if len(labels) >= 2:
        common = set.intersection(*(set(loaded[label][1]) for label in labels))
        selected_common = stride_holdouts(sorted(common), args.stride, args.min_holdout, args.max_holdout)
        ids_by_run = {label: loaded[label][2] for label in labels}
        overlap_mean, overlap_median = pairwise_overlap(ids_by_run, selected_common)
        blocks_by_run = {label: loaded[label][1] for label in labels}
        top_mean, top_median = top_pick_overlap(blocks_by_run, selected_common, "profitFactor", 1)
        print(f"CROSS_RUN | runs={','.join(labels)} | common_stride_windows={len(selected_common)} | visible_union_fingerprint_jaccard_mean={overlap_mean:.4f} median={overlap_median:.4f} | profitFactor_K1_pick_jaccard_mean={top_mean:.4f} median={top_median:.4f}")
        signatures: dict[str, set[str]] = {}
        for label in labels:
            signatures[label] = {
                json.dumps(row, sort_keys=True, separators=(",", ":"))
                for holdout in selected_common
                for block in loaded[label][1].get(holdout, {}).values()
                for row in block["rows"]
            }
        identical = sum(1 for left, right in combinations(labels, 2) if signatures[left] == signatures[right])
        print(f"INTEGRITY | exact_identical_visible_row_sets={identical} of {len(list(combinations(labels, 2)))} run pairs")


if __name__ == "__main__":
    main()
