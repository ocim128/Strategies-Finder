import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { fetchBinanceDataWithLimit } from "../lib/dataProviders/binance";
import { resolveBacktestSettingsFromRaw, CAPITAL_DEFAULTS } from "../lib/backtest-settings-resolver";
import { runGeneticOptimization, type GeneticOptimizerConfig } from "../lib/finder/genetic-optimizer";
import { trimToClosedCandles } from "../lib/closed-candle-utils";
import { strategies } from "../lib/strategies/library";
import { parseArgs as parseVerifyArgs, runVerification as runVerifyAlphaReport } from "./verify-alpha";
import { parseOhlcvBars } from "./lib/ohlcv-file";
import type { BacktestSettings, ExecutionModel, OHLCVData, Strategy, TradeDirection, TradeFilterMode } from "../lib/types/strategies";

type Cli = {
  symbol: string; interval: string; bars: number; freshnessHours: number;
  strategies: string[]; runs: number; population: number; generations: number; eliteCount: number;
  mutationRate: number; mutationSigma: number; rangePercent: number; minTrades: number; seed: number;
  adaptiveStagnation: number; adaptiveIncrease: number; adaptiveDecay: number; adaptiveMinRate: number; adaptiveMaxRate: number;
  initialCapital: number; positionSize: number; commission: number; sizingMode: "percent" | "fixed"; fixedTradeAmount: number;
  executionModel: ExecutionModel; tradeFilterMode: TradeFilterMode; slippageBps: number; allowSameBarExit: boolean;
  dataDir: string; outFile: string; verifiedOutFile: string; autoVerify: boolean;
  verifySeeds: number; verifyMinPass: number; verifyMaxCandidates: number;
};

type SeedRun = {
  seed: number; elapsedMs: number;
  fitness: { score: number; netProfitPercent: number; sharpeRatio: number; stability: number; maxDrawdownPercent: number; totalTrades: number };
  alphaGenome: Record<string, number>;
};

type StrategySurgicalResult = {
  strategyKey: string;
  seeds: number[];
  runs: SeedRun[];
  elapsedMs: number;
  aggregate: {
    robustScore: number;
    medianScore: number;
    medianNetProfitPercent: number;
    medianSharpeRatio: number;
    medianMaxDrawdownPercent: number;
    medianTotalTrades: number;
  };
  alphaGenome: Record<string, number>;
};

const DEFAULT_STRATEGIES = ["meta_harvest_v2", "bear_hunter_v5"];

function usage(): void {
  console.log(["Usage: npm run alpha:surgical", "Defaults: XRPUSDT 15m, pop=200, gens=150, runs=5"].join("\n"));
}

function num(v: string | undefined, d: number): number { const x = Number(v); return Number.isFinite(x) ? x : d; }
function pint(v: string | undefined, d: number, min = 1): number { return Math.max(min, Math.floor(num(v, d))); }
function bool(v: string | undefined, d: boolean): boolean {
  if (!v) return d; const t = v.toLowerCase();
  if (["1","true","yes","on"].includes(t)) return true;
  if (["0","false","no","off"].includes(t)) return false;
  return d;
}

function parse(argv: string[]): Cli & { help?: boolean } {
  let symbol = "XRPUSDT", interval = "15m", bars = 10000, freshnessHours = 4;
  let strategiesCsv = DEFAULT_STRATEGIES.join(","), runs = 5, population = 200, generations = 150, eliteCount = 10;
  let mutationRate = 0.12, mutationSigma = 0.12, rangePercent = 35, minTrades = 20, seed = 2026;
  let adaptiveStagnation = 12, adaptiveIncrease = 1.35, adaptiveDecay = 0.92, adaptiveMinRate = 0.08, adaptiveMaxRate = 0.45;
  let initialCapital = Number(CAPITAL_DEFAULTS.initialCapital), positionSize = Number(CAPITAL_DEFAULTS.positionSize), commission = Number(CAPITAL_DEFAULTS.commission);
  let sizingMode: "percent" | "fixed" = "percent"; let fixedTradeAmount = Number(CAPITAL_DEFAULTS.fixedTradeAmount);
  let executionModel: ExecutionModel = "signal_close"; let tradeFilterMode: TradeFilterMode = "none";
  let slippageBps = 0, allowSameBarExit = true;
  let dataDir = path.resolve("price-data", "universal"), outFile = path.resolve("alpha_report.json"), verifiedOutFile = path.resolve("verified_alpha.json");
  let autoVerify = true, verifySeeds = 5, verifyMinPass = 4, verifyMaxCandidates = 0;

  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], n = argv[i + 1];
    if (a === "--help" || a === "-h") return { help: true } as Cli & { help: boolean };
    if (a === "--symbol") { symbol = String(n ?? symbol).toUpperCase().trim(); i++; continue; }
    if (a === "--interval") { interval = String(n ?? interval).trim(); i++; continue; }
    if (a === "--bars") { bars = pint(n, bars, 1000); i++; continue; }
    if (a === "--fresh-hours") { freshnessHours = pint(n, freshnessHours, 1); i++; continue; }
    if (a === "--strategies") { strategiesCsv = String(n ?? strategiesCsv); i++; continue; }
    if (a === "--runs") { runs = pint(n, runs); i++; continue; }
    if (a === "--population") { population = pint(n, population, 10); i++; continue; }
    if (a === "--generations") { generations = pint(n, generations, 1); i++; continue; }
    if (a === "--elite") { eliteCount = pint(n, eliteCount, 1); i++; continue; }
    if (a === "--mutation-rate") { mutationRate = num(n, mutationRate); i++; continue; }
    if (a === "--mutation-sigma") { mutationSigma = num(n, mutationSigma); i++; continue; }
    if (a === "--range") { rangePercent = num(n, rangePercent); i++; continue; }
    if (a === "--min-trades") { minTrades = pint(n, minTrades, 0); i++; continue; }
    if (a === "--seed") { seed = pint(n, seed); i++; continue; }
    if (a === "--adaptive-stagnation") { adaptiveStagnation = pint(n, adaptiveStagnation, 1); i++; continue; }
    if (a === "--adaptive-increase") { adaptiveIncrease = num(n, adaptiveIncrease); i++; continue; }
    if (a === "--adaptive-decay") { adaptiveDecay = num(n, adaptiveDecay); i++; continue; }
    if (a === "--adaptive-min-rate") { adaptiveMinRate = num(n, adaptiveMinRate); i++; continue; }
    if (a === "--adaptive-max-rate") { adaptiveMaxRate = num(n, adaptiveMaxRate); i++; continue; }
    if (a === "--initial-capital") { initialCapital = num(n, initialCapital); i++; continue; }
    if (a === "--position-size") { positionSize = num(n, positionSize); i++; continue; }
    if (a === "--commission") { commission = num(n, commission); i++; continue; }
    if (a === "--sizing") { sizingMode = String(n ?? "").toLowerCase() === "fixed" ? "fixed" : "percent"; i++; continue; }
    if (a === "--fixed-trade-amount") { fixedTradeAmount = num(n, fixedTradeAmount); i++; continue; }
    if (a === "--execution") { const v = String(n ?? "").toLowerCase(); if (v === "signal_close" || v === "next_open" || v === "next_close") executionModel = v; i++; continue; }
    if (a === "--trade-filter") { const v = String(n ?? "").toLowerCase(); if (["none","close","volume","rsi","trend","adx","htf_drift"].includes(v)) tradeFilterMode = v as TradeFilterMode; i++; continue; }
    if (a === "--slippage-bps") { slippageBps = num(n, slippageBps); i++; continue; }
    if (a === "--allow-same-bar-exit") { allowSameBarExit = bool(n, allowSameBarExit); i++; continue; }
    if (a === "--data-dir") { dataDir = path.resolve(String(n ?? dataDir)); i++; continue; }
    if (a === "--out") { outFile = path.resolve(String(n ?? outFile)); i++; continue; }
    if (a === "--verified-out") { verifiedOutFile = path.resolve(String(n ?? verifiedOutFile)); i++; continue; }
    if (a === "--no-verify") { autoVerify = false; continue; }
    if (a === "--verify-seeds") { verifySeeds = pint(n, verifySeeds, 1); i++; continue; }
    if (a === "--verify-min-pass") { verifyMinPass = pint(n, verifyMinPass, 1); i++; continue; }
    if (a === "--verify-max-candidates") { verifyMaxCandidates = pint(n, verifyMaxCandidates, 0); i++; continue; }
    pos.push(a);
  }
  if (pos[0]) generations = pint(pos[0], generations, 1);
  if (pos[1]) population = pint(pos[1], population, 10);
  if (pos[2]) runs = pint(pos[2], runs, 1);
  if (pos[3]) bars = pint(pos[3], bars, 1000);
  if (pos[4]) verifySeeds = pint(pos[4], verifySeeds, 1);
  if (pos[5]) verifyMinPass = pint(pos[5], verifyMinPass, 1);
  if (pos[6]) verifyMaxCandidates = pint(pos[6], verifyMaxCandidates, 0);

  const strategies = strategiesCsv.split(",").map((s) => s.trim()).filter(Boolean);
  const minRate = Math.max(0, Math.min(1, adaptiveMinRate));
  const maxRate = Math.max(minRate, Math.min(1, adaptiveMaxRate));
  const verifySeedsSafe = Math.max(1, verifySeeds);
  const verifyMinSafe = Math.min(Math.max(1, verifyMinPass), verifySeedsSafe);

  return {
    symbol, interval, bars, freshnessHours, strategies: strategies.length > 0 ? strategies : [...DEFAULT_STRATEGIES], runs,
    population, generations, eliteCount: Math.max(1, Math.min(eliteCount, population)),
    mutationRate: Math.max(0, Math.min(1, mutationRate)), mutationSigma: Math.max(0.0001, mutationSigma), rangePercent: Math.max(0, rangePercent), minTrades: Math.max(0, minTrades), seed: Math.max(1, seed),
    adaptiveStagnation: Math.max(1, adaptiveStagnation), adaptiveIncrease: Math.max(1.01, adaptiveIncrease), adaptiveDecay: Math.max(0.5, Math.min(1, adaptiveDecay)), adaptiveMinRate: minRate, adaptiveMaxRate: maxRate,
    initialCapital: Math.max(1, initialCapital), positionSize: Math.max(0.0001, positionSize), commission: Math.max(0, commission), sizingMode, fixedTradeAmount: Math.max(0, fixedTradeAmount),
    executionModel, tradeFilterMode, slippageBps: Math.max(0, slippageBps), allowSameBarExit,
    dataDir, outFile, verifiedOutFile, autoVerify, verifySeeds: verifySeedsSafe, verifyMinPass: verifyMinSafe, verifyMaxCandidates: Math.max(0, verifyMaxCandidates),
  };
}

function freshnessMs(filePath: string): number | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    if (typeof raw.generatedAt === "string") {
      const parsed = Date.parse(raw.generatedAt);
      if (Number.isFinite(parsed)) return Date.now() - parsed;
    }
  } catch {}
  try { return Date.now() - fs.statSync(filePath).mtimeMs; } catch { return null; }
}

function inferDirection(strategy: Strategy): TradeDirection {
  const d = strategy.metadata?.direction;
  return d === "short" || d === "both" || d === "long" ? d : "long";
}

function buildPayload(symbol: string, interval: string, bars: OHLCVData[]): Record<string, unknown> {
  return { symbol, interval, provider: "Binance", bars: bars.length, generatedAt: new Date().toISOString(), data: bars.map((b) => ({ time: Number(b.time), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })) };
}

async function loadData(cfg: Cli): Promise<{ data: OHLCVData[]; filePath: string; source: "cached" | "fetched" }> {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const filePath = path.resolve(cfg.dataDir, `${cfg.symbol}-${cfg.interval}.json`);
  const age = freshnessMs(filePath);
  if (age !== null && age < cfg.freshnessHours * 60 * 60 * 1000) {
    const rows = parseOhlcvBars(JSON.parse(fs.readFileSync(filePath, "utf8")));
    if (rows.length >= cfg.bars) return { data: rows.slice(rows.length - cfg.bars), filePath, source: "cached" };
  }
  const fetched = await fetchBinanceDataWithLimit(cfg.symbol, cfg.interval, cfg.bars, { requestDelayMs: 30, maxRequests: Math.ceil(cfg.bars / 1000) + 2 });
  if (!Array.isArray(fetched) || fetched.length === 0) throw new Error(`[Surgical] Failed to fetch ${cfg.symbol} ${cfg.interval}`);
  fs.writeFileSync(filePath, JSON.stringify(buildPayload(cfg.symbol, cfg.interval, fetched), null, 2), "utf8");
  return { data: fetched, filePath, source: "fetched" };
}

function hashSeed(baseSeed: number, key: string): number {
  let h = baseSeed >>> 0;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return h >>> 0;
}

function runSeeds(baseSeed: number, symbol: string, strategy: string, count: number): number[] {
  const out: number[] = []; const seen = new Set<number>();
  let x = hashSeed(baseSeed, `${symbol}|${strategy}|surgical`) || 1;
  while (out.length < count) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    const s = ((x >>> 0) % 2147483646) + 1;
    if (seen.has(s)) continue;
    seen.add(s); out.push(s);
  }
  return out;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function aggregate(runs: SeedRun[]) {
  const score = median(runs.map((r) => r.fitness.score));
  const net = median(runs.map((r) => r.fitness.netProfitPercent));
  const sharpe = median(runs.map((r) => r.fitness.sharpeRatio));
  const dd = median(runs.map((r) => r.fitness.maxDrawdownPercent));
  const trades = median(runs.map((r) => r.fitness.totalTrades));
  const st = 1 / (1 + dd / 25);
  const robust = net > 0 && sharpe > 0 ? (net / 100) * sharpe * st : score - Math.abs(Math.min(0, net / 100)) * 0.25;
  return { robustScore: robust, medianScore: score, medianNetProfitPercent: net, medianSharpeRatio: sharpe, medianMaxDrawdownPercent: dd, medianTotalTrades: trades };
}

function pickGenome(runs: SeedRun[], agg: ReturnType<typeof aggregate>): Record<string, number> {
  let best = runs[0], dist = Number.POSITIVE_INFINITY;
  for (const r of runs) {
    const d = Math.abs(r.fitness.score - agg.medianScore) + Math.abs(r.fitness.netProfitPercent - agg.medianNetProfitPercent) * 0.02 + Math.abs(r.fitness.maxDrawdownPercent - agg.medianMaxDrawdownPercent) * 0.02;
    if (d < dist) { dist = d; best = r; }
  }
  return best.alphaGenome;
}

function gaConfig(cfg: Cli, seed: number): GeneticOptimizerConfig {
  return {
    populationSize: cfg.population, generations: cfg.generations, eliteCount: cfg.eliteCount,
    mutationRate: cfg.mutationRate, mutationSigma: cfg.mutationSigma, rangePercent: cfg.rangePercent,
    seed, tournamentSize: 2,
    adaptiveMutation: {
      enabled: true,
      stagnationGenerations: cfg.adaptiveStagnation,
      increaseFactor: cfg.adaptiveIncrease,
      decayFactor: cfg.adaptiveDecay,
      minRate: cfg.adaptiveMinRate,
      maxRate: cfg.adaptiveMaxRate,
    },
    backtest: {
      initialCapital: cfg.initialCapital,
      positionSize: cfg.positionSize,
      commission: cfg.commission,
      sizingMode: cfg.sizingMode,
      fixedTradeAmount: cfg.fixedTradeAmount,
      minTrades: cfg.minTrades,
    },
  };
}

async function runVerify(cfg: Cli): Promise<void> {
  const args = ["--in", cfg.outFile, "--out", cfg.verifiedOutFile, "--verify-seeds", String(cfg.verifySeeds), "--min-pass-count", String(cfg.verifyMinPass)];
  if (cfg.verifyMaxCandidates > 0) args.push("--max-candidates", String(cfg.verifyMaxCandidates));
  const parsed = parseVerifyArgs(args);
  if (parsed.help) throw new Error("[Surgical] verify parse returned help mode");
  await runVerifyAlphaReport(parsed);
}

async function main(): Promise<void> {
  const cfg = parse(process.argv.slice(2));
  if (cfg.help) { usage(); return; }

  const selected = cfg.strategies.map((k) => ({ key: k, strategy: (strategies as Record<string, Strategy>)[k] })).filter((s) => Boolean(s.strategy));
  if (selected.length === 0) throw new Error("[Surgical] No valid strategies");
  const skipped = cfg.strategies.filter((k) => !(k in strategies));
  if (skipped.length > 0) console.warn(`[Surgical] Skipping unknown strategies: ${skipped.join(", ")}`);

  const loaded = await loadData(cfg);
  const data = trimToClosedCandles(loaded.data, cfg.interval);
  if (data.length < 500) throw new Error(`[Surgical] Not enough closed candles: ${data.length}`);

  console.log(`[Surgical] Target=${cfg.symbol} ${cfg.interval} bars=${data.length} source=${loaded.source}`);
  console.log(`[Surgical] Deep Dive population=${cfg.population} generations=${cfg.generations} runs=${cfg.runs}`);

  const totalRuns = selected.length * cfg.runs;
  let completed = 0;
  const hunts: Array<StrategySurgicalResult & { fitness: { score: number; netProfitPercent: number; sharpeRatio: number; stability: number; maxDrawdownPercent: number; totalTrades: number } }> = [];
  const startedAt = Date.now();

  for (const s of selected) {
    const settings = resolveBacktestSettingsFromRaw({
      tradeDirection: inferDirection(s.strategy), executionModel: cfg.executionModel, tradeFilterMode: cfg.tradeFilterMode,
      allowSameBarExit: cfg.allowSameBarExit, slippageBps: cfg.slippageBps,
    } as BacktestSettings, { coerceWithoutUiToggles: true });

    const seeds = runSeeds(cfg.seed, cfg.symbol, s.key, cfg.runs);
    const runs: SeedRun[] = [];

    for (const seed of seeds) {
      const out = await runGeneticOptimization({
        strategyKey: s.key, strategy: s.strategy, data, backtestSettings: settings, config: gaConfig(cfg, seed),
        onGeneration: (g) => {
          const step = g.generation + 1;
          if (step !== 1 && step !== cfg.generations && step % 15 !== 0) return;
          console.log(`[Surgical][${s.key} seed=${seed}] gen ${step}/${cfg.generations} score=${g.bestScore.toFixed(6)} net=${g.bestNetProfitPercent.toFixed(2)}% dd=${g.bestDrawdownPercent.toFixed(2)}% mut=${g.mutationRate.toFixed(3)}`);
        },
      });

      const run: SeedRun = {
        seed, elapsedMs: Number(out.elapsedMs.toFixed(2)),
        fitness: {
          score: out.bestGenome.fitness.score, netProfitPercent: out.bestGenome.fitness.netProfitPercent, sharpeRatio: out.bestGenome.fitness.sharpeRatio,
          stability: out.bestGenome.fitness.stability, maxDrawdownPercent: out.bestGenome.fitness.maxDrawdownPercent, totalTrades: out.bestGenome.fitness.totalTrades,
        },
        alphaGenome: out.bestGenome.params,
      };
      runs.push(run);
      completed += 1;
      console.log(`[Surgical] ${completed}/${totalRuns} ${cfg.symbol} ${s.key} seed=${seed} -> score=${run.fitness.score.toFixed(6)} net=${run.fitness.netProfitPercent.toFixed(2)}% sharpe=${run.fitness.sharpeRatio.toFixed(3)} dd=${run.fitness.maxDrawdownPercent.toFixed(2)}%`);
    }

    const agg = aggregate(runs);
    hunts.push({
      strategyKey: s.key, seeds, runs, elapsedMs: Number(runs.reduce((acc, r) => acc + r.elapsedMs, 0).toFixed(2)),
      aggregate: agg, alphaGenome: pickGenome(runs, agg),
      fitness: {
        score: agg.robustScore, netProfitPercent: agg.medianNetProfitPercent, sharpeRatio: agg.medianSharpeRatio,
        stability: 1 / (1 + agg.medianMaxDrawdownPercent / 25), maxDrawdownPercent: agg.medianMaxDrawdownPercent, totalTrades: agg.medianTotalTrades,
      },
    });
  }

  hunts.sort((a, b) => b.aggregate.robustScore - a.aggregate.robustScore);
  const winners = hunts.map((h, i) => ({
    rank: i + 1, symbol: cfg.symbol, interval: cfg.interval, strategyKey: h.strategyKey,
    score: h.aggregate.robustScore, netProfitPercent: h.aggregate.medianNetProfitPercent, sharpeRatio: h.aggregate.medianSharpeRatio,
    maxDrawdownPercent: h.aggregate.medianMaxDrawdownPercent, totalTrades: h.aggregate.medianTotalTrades, alphaGenome: h.alphaGenome,
    runs: h.runs.length, seeds: h.seeds,
  }));

  const report = {
    generatedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt,
    config: {
      mode: "surgical", target: { symbol: cfg.symbol, interval: cfg.interval, bars: cfg.bars }, strategies: selected.map((s) => s.key),
      deepDive: { population: cfg.population, generations: cfg.generations, runsPerStrategy: cfg.runs, eliteCount: cfg.eliteCount },
      mutation: { baseRate: cfg.mutationRate, sigma: cfg.mutationSigma, rangePercent: cfg.rangePercent, adaptive: { stagnationGenerations: cfg.adaptiveStagnation, increaseFactor: cfg.adaptiveIncrease, decayFactor: cfg.adaptiveDecay, minRate: cfg.adaptiveMinRate, maxRate: cfg.adaptiveMaxRate } },
      backtest: { minTrades: cfg.minTrades, initialCapital: cfg.initialCapital, positionSize: cfg.positionSize, commission: cfg.commission, sizingMode: cfg.sizingMode, fixedTradeAmount: cfg.fixedTradeAmount, executionModel: cfg.executionModel, tradeFilterMode: cfg.tradeFilterMode, slippageBps: cfg.slippageBps, allowSameBarExit: cfg.allowSameBarExit },
    },
    market: { fetchedSymbol: cfg.symbol, interval: cfg.interval, bars: data.length, source: loaded.source, dataFile: loaded.filePath },
    winners,
    symbols: [{ rank: 1, symbol: cfg.symbol, interval: cfg.interval, quoteVolume: 0, bars: data.length, dataFile: loaded.filePath, hunts, winner: hunts[0] ?? null }],
  };

  fs.writeFileSync(cfg.outFile, JSON.stringify(report, null, 2), "utf8");
  console.log(`[Surgical] Wrote alpha report: ${cfg.outFile}`);

  if (cfg.autoVerify) {
    console.log("[Surgical] Running verify:alpha...");
    await runVerify(cfg);
    console.log(`[Surgical] Wrote verified report: ${cfg.verifiedOutFile}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(`surgical-optimization failed: ${message}`);
    process.exitCode = 1;
  });
}
