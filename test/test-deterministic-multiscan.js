import fs from "fs";
import path from "path";
import { config } from "../config.js";
import {
  formatDeterministicCandidateLine,
  rankDeterministicCandidates,
} from "../tools/deterministic-scoring.js";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function parseList(name, fallback) {
  const value = argValue(name, null);
  if (!value) return fallback;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function numeric(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(n) {
  return n != null ? Math.round(n) : null;
}

function fix(n, decimals) {
  const value = Number(n);
  return Number.isFinite(value) ? Number(value.toFixed(decimals)) : null;
}

function includesCaseInsensitive(values, value) {
  if (!Array.isArray(values) || values.length === 0 || !value) return false;
  const needle = String(value).toLowerCase();
  return values.some((entry) => String(entry).toLowerCase() === needle);
}

function getPoolLaunchpad(pool) {
  const base = pool?.token_x || {};
  return base?.launchpad ||
    base?.launchpad_platform ||
    pool?.base_token_launchpad ||
    pool?.launchpad ||
    pool?.launchpad_platform ||
    null;
}

function buildFilters({ relaxed = false } = {}) {
  const s = config.screening;
  return [
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    s.excludeHighSupplyConcentration ? "base_token_has_high_supply_concentration=false" : null,
    "base_token_has_high_single_ownership=false",
    "pool_type=dlmm",
    `base_token_market_cap>=${s.minMcap}`,
    `base_token_market_cap<=${s.maxMcap}`,
    `base_token_holders>=${s.minHolders}`,
    `volume>=${s.minVolume}`,
    `tvl>=${s.minTvl}`,
    !relaxed && s.maxTvl != null ? `tvl<=${s.maxTvl}` : null,
    `dlmm_bin_step>=${s.minBinStep}`,
    `dlmm_bin_step<=${s.maxBinStep}`,
    `fee_active_tvl_ratio>=${s.minFeeActiveTvlRatio}`,
    `base_token_organic_score>=${s.minOrganic}`,
    `quote_token_organic_score>=${s.minQuoteOrganic}`,
    s.minTokenAgeHours != null ? `base_token_created_at<=${Date.now() - s.minTokenAgeHours * 3_600_000}` : null,
    s.maxTokenAgeHours != null ? `base_token_created_at>=${Date.now() - s.maxTokenAgeHours * 3_600_000}` : null,
    Array.isArray(s.allowedLaunchpads) && s.allowedLaunchpads.length > 0
      ? `base_token_launchpad=[${s.allowedLaunchpads.join(",")}]`
      : null,
  ].filter(Boolean).join("&&");
}

function rejectRawPool(pool, { relaxed = false } = {}) {
  const s = config.screening;
  const base = pool?.token_x || {};
  const quote = pool?.token_y || {};
  const binStep = numeric(pool?.dlmm_params?.bin_step);
  const tvl = numeric(pool?.tvl ?? pool?.active_tvl);
  const feeActiveTvlRatio = numeric(pool?.fee_active_tvl_ratio);
  const volatility = numeric(pool?.volatility);
  const volume = numeric(pool?.volume);
  const holders = numeric(pool?.base_token_holders);
  const mcap = numeric(base?.market_cap);
  const baseOrganic = numeric(base?.organic_score);
  const quoteOrganic = numeric(quote?.organic_score);
  const launchpad = getPoolLaunchpad(pool);

  if (s.excludeHighSupplyConcentration && pool?.base_token_has_high_supply_concentration === true) return "base token has high supply concentration";
  if (pool?.base_token_has_critical_warnings === true) return "base token has critical warnings";
  if (pool?.quote_token_has_critical_warnings === true) return "quote token has critical warnings";
  if (pool?.base_token_has_high_single_ownership === true) return "base token has high single ownership";
  if (pool?.pool_type && pool.pool_type !== "dlmm") return `pool_type ${pool.pool_type} is not dlmm`;
  if (mcap == null || mcap < s.minMcap) return `mcap ${mcap ?? "unknown"} below minMcap ${s.minMcap}`;
  if (mcap > s.maxMcap) return `mcap ${mcap} above maxMcap ${s.maxMcap}`;
  if (holders == null || holders < s.minHolders) return `holders ${holders ?? "unknown"} below minHolders ${s.minHolders}`;
  if (volume == null || volume < s.minVolume) return `volume ${volume ?? "unknown"} below minVolume ${s.minVolume}`;
  if (tvl == null || tvl < s.minTvl) return `TVL ${tvl ?? "unknown"} below minTvl ${s.minTvl}`;
  if (!relaxed && s.maxTvl != null && tvl > s.maxTvl) return `TVL ${tvl} above maxTvl ${s.maxTvl}`;
  if (binStep == null || binStep < s.minBinStep) return `bin_step ${binStep ?? "unknown"} below minBinStep ${s.minBinStep}`;
  if (binStep > s.maxBinStep) return `bin_step ${binStep} above maxBinStep ${s.maxBinStep}`;
  if (feeActiveTvlRatio == null || feeActiveTvlRatio < s.minFeeActiveTvlRatio) return `fee/active-TVL ${feeActiveTvlRatio ?? "unknown"} below minFeeActiveTvlRatio ${s.minFeeActiveTvlRatio}`;
  if (volatility == null || volatility <= 0) return `volatility ${volatility ?? "unknown"} is unusable`;
  if (baseOrganic == null || baseOrganic < s.minOrganic) return `base organic ${baseOrganic ?? "unknown"} below minOrganic ${s.minOrganic}`;
  if (quoteOrganic == null || quoteOrganic < s.minQuoteOrganic) return `quote organic ${quoteOrganic ?? "unknown"} below minQuoteOrganic ${s.minQuoteOrganic}`;
  if (includesCaseInsensitive(s.blockedLaunchpads, launchpad)) return `blocked launchpad (${launchpad})`;
  return null;
}

function condensePool(p, { timeframe, category }) {
  return {
    pool: p.pool_address,
    name: p.name,
    source_timeframe: timeframe,
    source_category: category,
    base: {
      symbol: p.token_x?.symbol,
      mint: p.token_x?.address,
      organic: Math.round(p.token_x?.organic_score || 0),
      warnings: p.token_x?.warnings?.length || 0,
    },
    quote: {
      symbol: p.token_y?.symbol,
      mint: p.token_y?.address,
    },
    pool_type: p.pool_type,
    bin_step: p.dlmm_params?.bin_step || null,
    fee_pct: p.fee_pct,
    tvl: round(p.tvl),
    active_tvl: round(p.active_tvl),
    fee_window: round(p.fee),
    volume_window: round(p.volume),
    fee_active_tvl_ratio: p.fee_active_tvl_ratio != null ? fix(p.fee_active_tvl_ratio, 4) : null,
    volatility: fix(p.volatility, 4),
    volatility_timeframe: timeframe,
    holders: p.base_token_holders,
    mcap: round(p.token_x?.market_cap),
    organic_score: Math.round(p.token_x?.organic_score || 0),
    token_age_hours: p.token_x?.created_at
      ? Math.floor((Date.now() - p.token_x.created_at) / 3_600_000)
      : null,
    dev: p.token_x?.dev || null,
    launchpad: getPoolLaunchpad(p),
    active_positions: p.active_positions,
    active_pct: fix(p.active_positions_pct, 1),
    open_positions: p.open_positions,
    price: p.pool_price,
    price_change_pct: fix(p.pool_price_change_pct, 1),
    price_trend: p.price_trend,
    min_price: p.min_price,
    max_price: p.max_price,
    volume_change_pct: fix(p.volume_change_pct, 1),
    fee_change_pct: fix(p.fee_change_pct, 1),
    swap_count: p.swap_count,
    unique_traders: p.unique_traders,
  };
}

async function fetchPools({ pageSize, timeframe, category, relaxed }) {
  const filters = buildFilters({ relaxed });
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=${pageSize}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=${encodeURIComponent(timeframe)}` +
    `&category=${encodeURIComponent(category)}`;

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Pool Discovery API error ${res.status}: ${res.statusText}${body ? ` — ${body.slice(0, 180)}` : ""}`);
  }
  const data = await res.json();
  const raw = Array.isArray(data.data) ? data.data : [];
  const filtered = [];
  const pools = raw
    .filter((pool) => {
      const reason = rejectRawPool(pool, { relaxed });
      if (reason) {
        filtered.push({ name: pool.name || pool.pool_address || "unknown", reason });
        return false;
      }
      return true;
    })
    .map((pool) => condensePool(pool, { timeframe, category }));

  return { total: data.total ?? raw.length, raw_count: raw.length, pools, filtered };
}

function uniqueByPool(scans) {
  const byPool = new Map();
  for (const scan of scans) {
    for (const pool of scan.pools) {
      const existing = byPool.get(pool.pool);
      if (!existing || Number(pool.fee_active_tvl_ratio || 0) > Number(existing.fee_active_tvl_ratio || 0)) {
        byPool.set(pool.pool, pool);
      }
    }
  }
  return [...byPool.values()];
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function saveSnapshot(payload) {
  const dir = path.join(process.cwd(), "logs", "screening-snapshots");
  ensureDir(dir);
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `${day}-multiscan.jsonl`);
  fs.appendFileSync(file, JSON.stringify(payload) + "\n");
  return file;
}

async function main() {
  const pageSize = Number(argValue("page-size", 50));
  const limit = Number(argValue("limit", 20));
  const relaxed = hasFlag("relaxed");
  const snapshot = hasFlag("snapshot");
  const stopOnError = hasFlag("stop-on-error");
  const timeframes = parseList("timeframes", [argValue("timeframe", config.screening.timeframe || "5m")]);
  const categories = parseList("categories", [argValue("category", config.screening.category || "trending")]);

  console.log("=== Deterministic DLMM Multi-Scan ===\n");
  console.log(`timeframes=${timeframes.join(",")} categories=${categories.join(",")} page_size=${pageSize} relaxed=${relaxed}`);

  const scans = [];
  const errors = [];
  for (const timeframe of timeframes) {
    for (const category of categories) {
      try {
        const scan = await fetchPools({ pageSize, timeframe, category, relaxed });
        scans.push({ timeframe, category, ...scan });
        console.log(`- ${timeframe}/${category}: api_total=${scan.total}, raw=${scan.raw_count}, after_filters=${scan.pools.length}`);
      } catch (error) {
        const message = error?.message || String(error);
        errors.push({ timeframe, category, error: message });
        console.log(`- ${timeframe}/${category}: SKIP (${message})`);
        if (stopOnError) throw error;
      }
    }
  }

  const candidates = uniqueByPool(scans);
  const ranked = rankDeterministicCandidates(candidates).slice(0, limit);

  console.log(`\nSuccessful scans: ${scans.length}/${timeframes.length * categories.length}`);
  if (errors.length > 0) {
    console.log(`Skipped scans: ${errors.length}`);
  }
  console.log(`Unique candidates after filters: ${candidates.length}`);
  console.log(`Showing top ${ranked.length}\n`);

  for (const [index, entry] of ranked.entries()) {
    const p = entry.pool;
    console.log(`${formatDeterministicCandidateLine(entry, index)} | source=${p.source_timeframe}/${p.source_category}`);
    const d = entry.deterministic;
    const penaltyText = d.penalties.length ? d.penalties.map((penalty) => `${penalty.name}=-${penalty.value}`).join(", ") : "none";
    console.log(`    components=${JSON.stringify(d.components)}`);
    console.log(`    penalties=${penaltyText}`);
    console.log(`    hard_flags=${d.hard_flags.length ? d.hard_flags.join("; ") : "none"}`);
  }

  if (snapshot) {
    const file = saveSnapshot({
      ts: new Date().toISOString(),
      mode: "deterministic-multiscan",
      timeframes,
      categories,
      page_size: pageSize,
      relaxed,
      errors,
      scan_summary: scans.map(({ timeframe, category, total, raw_count, pools, filtered }) => ({
        timeframe,
        category,
        total,
        raw_count,
        after_filters: pools.length,
        filtered_examples: filtered.slice(0, 5),
      })),
      ranked: ranked.map(({ pool, deterministic }) => ({
        pool: pool.pool,
        name: pool.name,
        source_timeframe: pool.source_timeframe,
        source_category: pool.source_category,
        base: pool.base,
        quote: pool.quote,
        deterministic,
      })),
    });
    console.log(`\nSnapshot saved: ${file}`);
  }

  console.log("\n=== Done ===");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
