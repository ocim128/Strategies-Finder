#!/usr/bin/env python3
"""Independent raw-archive checks for agent-audit-2026-08-23.md.

This is intentionally a stdlib-only parser. It uses (symbol, strategyId,
candidateFingerprint) tuples for archive-pool deduplication.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import statistics
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
UP = ROOT / "archive" / "asset opportunity" / "Decision Rule Research" / "output collection" / "uptrend-only"
TARGETS = [
    "run-2116-21aug2026",
    "run-0506-22aug2026",
    "run-0816-22aug2026",
    "run-2325-22aug2026",
    "run-0535-23aug2026",
]
RELATED = [
    "run-2157-22aug2026-A-TP1SL1",
    "run-1105-22aug2026",
    "run-1523-22aug2026",
    "run-1800-22aug2026",
    "run-0949-22aug2026",
    "run-1258-22aug2026",
]
HOLDOUTS = list(range(12, 301, 12))
BLOCK_RE = re.compile(
    r"^={80}\nTimestamp: (?P<timestamp>.*?)\n"
    r"Batch run id: (?P<batch>.*?)\nOOS holdout: (?P<holdout>\d+) bars\n"
    r"Archive sort: (?P<sort>.*?)\n"
    r"(?:Archive baseline: (?P<baseline>.*?)\n)?={80}\n"
    r"(?P<payload>.*?)(?=\n={80}\n|\Z)",
    re.M | re.S,
)


def finite(value):
    return isinstance(value, (int, float)) and math.isfinite(value)


def read_json_object(text: str):
    start = text.find("{")
    return json.loads(text[start:]) if start >= 0 else {}


def parse_archive_file(path: Path):
    text = path.read_text(encoding="utf-8", errors="replace")
    blocks = []
    for match in BLOCK_RE.finditer(text):
        baseline = json.loads(match.group("baseline")) if match.group("baseline") else None
        rows = json.loads(match.group("payload"))
        blocks.append({
            "timestamp": match.group("timestamp"),
            "batch": match.group("batch"),
            "holdout": int(match.group("holdout")),
            "sort": match.group("sort"),
            "baseline": baseline,
            "rows": rows,
        })
    return blocks


def parse_pair_summary_file(path: Path):
    text = path.read_text(encoding="utf-8", errors="replace")
    marker = "Pair summaries: JSON\n"
    pos = text.find(marker)
    if pos < 0:
        return None
    payload = text[pos + len(marker):]
    if payload.startswith("=" * 80):
        payload = payload[len("=" * 80):]
    end = payload.find("\n" + "=" * 80)
    if end >= 0:
        payload = payload[:end]
    return json.loads(payload.strip())


def load_run(name: str):
    folder = UP / name
    files = sorted(folder.glob("oos-holdout-*-bars.txt"), key=lambda p: int(re.search(r"(\d+)", p.name).group(1)))
    blocks = []
    for path in files:
        blocks.extend(parse_archive_file(path))
    latest = {}
    for block in blocks:
        key = (block["holdout"], block["sort"])
        previous = latest.get(key)
        if previous is None or (block["timestamp"], block["batch"]) > (previous["timestamp"], previous["batch"]):
            latest[key] = block
    by_holdout = {}
    for block in latest.values():
        by_holdout.setdefault(block["holdout"], {})[block["sort"]] = block
    config = read_json_object((folder / "config.txt").read_text(encoding="utf-8", errors="replace"))
    summaries = {}
    for path in sorted(folder.glob("oos-pair-summary-*-bars.txt")):
        holdout = int(re.search(r"(\d+)", path.name).group(1))
        summaries[holdout] = parse_pair_summary_file(path)
    return {"name": name, "folder": folder, "blocks": blocks, "by_holdout": by_holdout, "config": config, "summaries": summaries}


def candidate_key(row):
    return (row.get("symbol", ""), row.get("strategyId", ""), row.get("candidateFingerprint", ""))


def forward(row, horizon=12):
    performance = row.get("forwardOosPerformance") or {}
    for item in performance.get("horizons", []):
        if item.get("bars") == horizon and finite(item.get("pnlPercent")) and item.get("sampleSize", 0) > 0:
            return float(item["pnlPercent"])
    return None


def pool_for(run, holdout, horizon=12):
    blocks = run["by_holdout"].get(holdout, {}).values()
    unique = {}
    for block in blocks:
        for row in block["rows"]:
            value = forward(row, horizon)
            if value is not None:
                unique[candidate_key(row)] = value
    values = list(unique.values())
    return values, unique


def selected_value(run, holdout, sort_name, horizon=12):
    block = run["by_holdout"].get(holdout, {}).get(sort_name)
    if block is None:
        return None
    rows = [row for row in block["rows"] if row.get("rank") == 1]
    values = [forward(row, horizon) for row in rows]
    values = [value for value in values if value is not None]
    return statistics.mean(values) if values else None


def mean(values):
    values = [value for value in values if value is not None]
    return statistics.mean(values) if values else None


def median(values):
    values = [value for value in values if value is not None]
    return statistics.median(values) if values else None


def pct(values):
    values = [value for value in values if value is not None]
    return 100 * sum(value > 0 for value in values) / len(values) if values else None


def exact_profit_factor(run, friction_bps=0):
    deltas = []
    rows = []
    friction_pct = friction_bps / 100
    for holdout in HOLDOUTS:
        pool, _ = pool_for(run, holdout)
        selected = selected_value(run, holdout, "profitFactor")
        if pool and selected is not None:
            gross = selected - statistics.mean(pool)
            rows.append({"holdout": holdout, "gross": gross, "reported": gross - friction_pct, "pool": len(pool)})
            deltas.append(gross - friction_pct)
    return rows, deltas


def percentile(values, fraction):
    values = sorted(values)
    if not values:
        return None
    index = round((len(values) - 1) * fraction)
    return values[index]


def summarize(values):
    return {
        "n": len(values),
        "mean": mean(values),
        "median": median(values),
        "positive_pct": pct(values),
        "p05": percentile(values, 0.05),
        "p95": percentile(values, 0.95),
    }


def pool_stats(run):
    result = []
    for holdout in HOLDOUTS:
        blocks = run["by_holdout"].get(holdout, {})
        pool, unique = pool_for(run, holdout)
        eligible = None
        for block in blocks.values():
            if block.get("baseline"):
                eligible = block["baseline"].get("eligibleCandidateCount")
                break
        result.append({"holdout": holdout, "eligible": eligible, "visible": len(unique), "forward_rows": len(pool)})
    return result


def jaccard(a, b):
    if not a and not b:
        return 1.0
    return len(a & b) / len(a | b) if a | b else 1.0


def pool_keys(run, holdout):
    return set(pool_for(run, holdout)[1])


def pool_fingerprint_keys(run, holdout):
    return {key[2] for key in pool_keys(run, holdout)}


def rng(seed):
    state = seed & 0xffffffff
    while True:
        state = (state + 0x6D2B79F5) & 0xffffffff
        t = (state ^ (state >> 15)) & 0xffffffff
        t = (t * (1 | state)) & 0xffffffff
        t = (t ^ ((t + (((t ^ (t >> 7)) * (61 | t)) & 0xffffffff)) & 0xffffffff)) & 0xffffffff
        yield ((t ^ (t >> 14)) & 0xffffffff) / 4294967296


def bootstrap(values, seed=42, iterations=2000):
    random = rng(seed)
    samples = []
    for _ in range(iterations):
        samples.append(mean([values[int(next(random) * len(values))] for _ in values]))
    return {"p05": percentile(samples, 0.05), "p50": percentile(samples, 0.50), "p95": percentile(samples, 0.95), "positive_pct": pct(samples)}


def rankdata(values):
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i + 1
        while j < len(order) and values[order[j]] == values[order[i]]:
            j += 1
        rank = (i + 1 + j) / 2
        for k in order[i:j]:
            ranks[k] = rank
        i = j
    return ranks


def pearson(x, y):
    if len(x) < 3:
        return None
    mx, my = mean(x), mean(y)
    dx = [value - mx for value in x]
    dy = [value - my for value in y]
    denom = math.sqrt(sum(value * value for value in dx) * sum(value * value for value in dy))
    return sum(a * b for a, b in zip(dx, dy)) / denom if denom else 0.0


def spearman(x, y):
    return pearson(rankdata(x), rankdata(y))


def config_summary(run):
    config = run["config"]
    finder = config.get("finder", {})
    opportunity = finder.get("assetOpportunity", {})
    backtest = config.get("backtestSettings", {})
    symbols = opportunity.get("symbols", [])
    strategy_keys = config.get("strategyKeys", [])
    digest = lambda value: hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()[:12]
    return {
        "evalLastBars": opportunity.get("evalLastBars"),
        "oosIgnoreLastBars": opportunity.get("oosIgnoreLastBars"),
        "dataSlice": finder.get("dataSlice"),
        "sortPriority": finder.get("sortPriority"),
        "strategies": len(run["config"].get("strategyKeys", [])),
        "symbols": len(symbols),
        "symbols_digest": digest(symbols),
        "strategy_digest": digest(strategy_keys),
        "slippageBps": backtest.get("slippageBps"),
        "commission": config.get("capitalSettings", {}).get("commission"),
        "summary_count": len(run["summaries"]),
    }


def pair_ic(run):
    features = ["candidateCount", "profitableShare", "medianNetProfitPercent", "netProfitP75MinusP25", "medianExpectancy", "topNetProfit"]
    all_rows = {holdout: {row.get("symbol"): row for row in rows or []} for holdout, rows in run["summaries"].items()}
    result = {feature: [] for feature in features}
    for holdout in HOLDOUTS:
        by_symbol = all_rows.get(holdout, {})
        for feature in features:
            pairs = [(row.get(feature), (row.get("forwardPnlPercentByHorizon") or {}).get("12")) for row in by_symbol.values()]
            pairs = [(float(x), float(y)) for x, y in pairs if finite(x) and finite(y)]
            if len(pairs) >= 3:
                result[feature].append({"holdout": holdout, "ic": spearman([p[0] for p in pairs], [p[1] for p in pairs]), "n": len(pairs)})
    return result


def pair_feature_summary(run):
    rows = [row for holdout in HOLDOUTS for row in (run["summaries"].get(holdout) or [])]
    return {
        "rows": len(rows),
        "mean_candidateCount": mean([row.get("candidateCount") for row in rows]),
        "median_candidateCount": median([row.get("candidateCount") for row in rows]),
        "mean_profitableShare": mean([row.get("profitableShare") for row in rows]),
        "median_profitableShare": median([row.get("profitableShare") for row in rows]),
        "mean_dispersion": mean([row.get("netProfitP75MinusP25") for row in rows]),
    }


def run_report(run):
    rows, deltas = exact_profit_factor(run)
    pf = summarize(deltas)
    pf["bootstrap"] = bootstrap(deltas) if deltas else None
    inv_rows = []
    for holdout in HOLDOUTS:
        pool, _ = pool_for(run, holdout)
        selected = selected_value(run, holdout, "invertedWinRate")
        if pool and selected is not None:
            inv_rows.append(selected - mean(pool))
    return {"config": config_summary(run), "pf": pf, "invertedWinRate": summarize(inv_rows), "pool": pool_stats(run)}


def print_json(label, value):
    print(label + "=" + json.dumps(value, separators=(",", ":"), sort_keys=True))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--related", action="store_true")
    parser.add_argument("--compact", action="store_true")
    args = parser.parse_args()
    runs = {name: load_run(name) for name in TARGETS}
    if args.compact:
        for name, run in runs.items():
            report = run_report(run)
            pool = report["pool"]
            rows, _ = exact_profit_factor(run, friction_bps=30)
            print(name, json.dumps({
                "config": report["config"],
                "pf": report["pf"],
                "pf_friction30": {"gross": mean([row["gross"] for row in rows]), "reported": mean([row["reported"] for row in rows])},
                "pool_mean": {"eligible": mean([row["eligible"] for row in pool]), "visible": mean([row["visible"] for row in pool]), "min_visible": min(row["visible"] for row in pool), "max_visible": max(row["visible"] for row in pool)},
                "pair_summary": pair_feature_summary(run),
            }, separators=(",", ":")))
        print("PAIR_IC_COMPACT")
        for name in TARGETS:
            compact = {}
            for feature, values in pair_ic(runs[name]).items():
                ics = [item["ic"] for item in values]
                compact[feature] = {"n": len(ics), "mean": mean(ics), "median": median(ics), "positive_pct": pct(ics), "early": mean(ics[:len(ics)//2]), "late": mean(ics[len(ics)//2:])}
            print(name, json.dumps(compact, separators=(",", ":")))
        print("QUARTILE_PF")
        for name, run in runs.items():
            values = [row["gross"] for row in exact_profit_factor(run)[0]]
            chunks = [values[0:6], values[6:12], values[12:18], values[18:25]]
            print(name, json.dumps([mean(chunk) for chunk in chunks], separators=(",", ":")))
        print("SAME_WINDOW_COMPACT")
        deltas_by_run = {name: {row["holdout"]: row["gross"] for row in exact_profit_factor(run)[0]} for name, run in runs.items()}
        early_late = []
        for holdout in HOLDOUTS:
            early = [deltas_by_run[name].get(holdout) for name in TARGETS[:3]]
            late = [deltas_by_run[name].get(holdout) for name in TARGETS[3:]]
            early_late.append((mean(early), mean(late)))
        print(json.dumps({"early_group_mean": mean([pair[0] for pair in early_late]), "late_group_mean": mean([pair[1] for pair in early_late]), "mean_change": mean([pair[1] - pair[0] for pair in early_late]), "same_sign_run3_run4_pct": pct([deltas_by_run[TARGETS[2]][h] * deltas_by_run[TARGETS[3]][h] for h in HOLDOUTS]), "same_sign_run3_run5_pct": pct([deltas_by_run[TARGETS[2]][h] * deltas_by_run[TARGETS[4]][h] for h in HOLDOUTS])}, separators=(",", ":")))
        print("POOL_OVERLAP_COMPACT")
        for i, left in enumerate(TARGETS):
            for right in TARGETS[i + 1:]:
                values = [jaccard(pool_keys(runs[left], h), pool_keys(runs[right], h)) for h in HOLDOUTS]
                intersections = [len(pool_keys(runs[left], h) & pool_keys(runs[right], h)) for h in HOLDOUTS]
                fingerprint_values = [jaccard(pool_fingerprint_keys(runs[left], h), pool_fingerprint_keys(runs[right], h)) for h in HOLDOUTS]
                print(left + "|" + right, json.dumps({"tuple_mean_jaccard": mean(values), "tuple_min_jaccard": min(values), "tuple_max_jaccard": max(values), "tuple_mean_intersection": mean(intersections), "fingerprint_only_diagnostic_mean_jaccard": mean(fingerprint_values)}, separators=(",", ":")))
        if args.related:
            print("RELATED_COMPACT")
            for name in RELATED:
                report = run_report(load_run(name))
                print(name, json.dumps({"config": report["config"], "pf": report["pf"], "invertedWinRate": report["invertedWinRate"]}, separators=(",", ":")))
        return
    for name, run in runs.items():
        print_json("RUN " + name, run_report(run))
        rows, _ = exact_profit_factor(run, friction_bps=30)
        print_json("FRICTION30 " + name, {"mean_reported": mean([row["reported"] for row in rows]), "mean_gross": mean([row["gross"] for row in rows])})
    print("CONFIGS")
    for name, run in runs.items():
        print(name, json.dumps(config_summary(run), sort_keys=True))
    print("PAIR_IC")
    for name in TARGETS:
        result = pair_ic(runs[name])
        compact = {}
        for feature, values in result.items():
            ics = [item["ic"] for item in values]
            compact[feature] = {"n_windows": len(ics), "mean": mean(ics), "median": median(ics), "positive_pct": pct(ics), "early": mean(ics[:len(ics)//2]), "late": mean(ics[len(ics)//2:])}
        print(name, json.dumps(compact, sort_keys=True))
    print("SAME_WINDOW")
    deltas_by_run = {name: {row["holdout"]: row["gross"] for row in exact_profit_factor(run)[0]} for name, run in runs.items()}
    for holdout in HOLDOUTS:
        early = [deltas_by_run[name].get(holdout) for name in TARGETS[:3]]
        late = [deltas_by_run[name].get(holdout) for name in TARGETS[3:]]
        print(holdout, json.dumps({"early_mean": mean(early), "late_mean": mean(late), "change": mean(late) - mean(early) if mean(early) is not None and mean(late) is not None else None, "early_signs": [value > 0 for value in early], "late_signs": [value > 0 for value in late]}, separators=(",", ":")))
    print("POOL_OVERLAP")
    for holdout in HOLDOUTS:
        sets = {name: pool_keys(run, holdout) for name, run in runs.items()}
        pair = {}
        for left in TARGETS:
            for right in TARGETS:
                if TARGETS.index(left) < TARGETS.index(right):
                    pair[left + "|" + right] = {"jaccard": jaccard(sets[left], sets[right]), "intersection": len(sets[left] & sets[right]), "left": len(sets[left]), "right": len(sets[right])}
        print(holdout, json.dumps(pair, separators=(",", ":")))
    if args.related:
        print("RELATED")
        for name in RELATED:
            run = load_run(name)
            print_json("RUN " + name, run_report(run))


if __name__ == "__main__":
    main()
