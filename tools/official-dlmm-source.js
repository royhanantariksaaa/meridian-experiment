import fs from "fs";
import path from "path";
import { config } from "../config.js";
import { log } from "../logger.js";
import { isBlacklisted } from "../token-blacklist.js";
import { getBlockedDevs, isDevBlocked } from "../dev-blocklist.js";

const OFFICIAL_DLMM_BASE = "https://dlmm.datapi.meteora.ag";
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const CACHE_DIR = path.join(process.cwd(), "logs", "market-cache");
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_PAGES = 1;
const DEFAULT_ENRICH_LIMIT = 30;
const DEFAULT_ENRICH_DELAY_MS = 120;
const WINDOW_FALLBACKS = ["5m", "30m", "1h", "2h", "4h", "12h", "24h"];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeKey(value) {
  return String(value || "default").replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 120);
}

function cachePath(key) {
  ensureDir(CACHE_DIR);
  return path.join(CACHE_DIR, `${safeKey(key)}.json`);
}

function readCache(key, ttlMs) {
  const file = cachePath(key);
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > ttlMs) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(key, payload) {
  const file = cachePath(key);
  try {
    fs.writeFileSync(file, JSON.stringify(payload));
  } catch (error) {
    log("cache_warn", `Failed to write ${file}: ${error.message}`);
  }
}

function numeric(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 4) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(decimals)) : null;
}

function getWindowMetric(metricMap, requestedWindow) {
  if (metricMap == null || typeof metricMap !== "object") return null;
  const requested = String(requestedWindow || "").trim();
  const candidates = [requested, ...WINDOW_FALLBACKS.filter((w) => w !== requested)];
  for (const window of candidates) {
    const value = numeric(metricMap[window]);
    if (value != null) return value;
  }
  return null;
}

function getMetricWindow(timeframe = config.screening.timeframe || "1h") {
  const tf = String(timeframe || "1h").trim();
  return tf || "1h";
}

function scorePool(pool) {
  const feeTvl = numeric(pool.fee_active_tvl_ratio, 0);
  const volume = numeric(pool.volume_window, 0);
  const activeTvl = numeric(pool.active_tvl ?? pool.tvl, 0);
  const volActive = activeTvl > 0 ? volume / activeTvl : 0;
  const organic = numeric(pool.organic_score ?? pool.base?.organic, 0);
  const holders = numeric(pool.holders, 0);
  return feeTvl * 1000 + volActive * 250 + organic * 10 + holders / 100;
}

function getLaunchpad(pool) {
  return pool?.launchpad || pool?.token_x?.launchpad || pool?.token_x?.launchpad_platform || null;
}

function getDev(pool) {
  return pool?.dev || pool?.token_x?.dev || null;
}

function includesCaseInsensitive(values, value) {
  if (!Array.isArray(values) || values.length === 0 || !value) return false;
  const needle = String(value).toLowerCase();
  return values.some((entry) => String(entry).toLowerCase() === needle);
}

function normalizeOfficialPool(pool, { metricWindow }) {
  const tokenX = pool?.token_x || {};
  const tokenY = pool?.token_y || {};
  const binStep = numeric(pool?.pool_config?.bin_step);
  const feePct = numeric(pool?.pool_config?.base_fee_pct ?? pool?.dynamic_fee_pct);
  const volumeWindow = getWindowMetric(pool?.volume, metricWindow);
  const feeWindow = getWindowMetric(pool?.fees, metricWindow);
  const feeTvlRatio = getWindowMetric(pool?.fee_tvl_ratio, metricWindow);
  const tvl = numeric(pool?.tvl);
  const activeTvl = numeric(pool?.active_tvl ?? pool?.tvl);
  const createdAt = numeric(pool?.created_at);

  return {
    pool: pool?.address,
    name: pool?.name || `${tokenX.symbol || "?"}-${tokenY.symbol || "?"}`,
    source_timeframe: metricWindow,
    source_category: "official",
    source_api: "official-dlmm-pools",
    base: {
      symbol: tokenX.symbol,
      mint: tokenX.address,
      organic: null,
      warnings: 0,
    },
    quote: {
      symbol: tokenY.symbol,
      mint: tokenY.address,
    },
    pool_type: "dlmm",
    bin_step: binStep,
    fee_pct: feePct,
    tvl: tvl != null ? Math.round(tvl) : null,
    active_tvl: activeTvl != null ? Math.round(activeTvl) : null,
    fee_window: feeWindow != null ? Math.round(feeWindow) : null,
    volume_window: volumeWindow != null ? Math.round(volumeWindow) : null,
    fee_active_tvl_ratio: feeTvlRatio != null ? round(feeTvlRatio, 4) : null,
    volatility: null,
    volatility_timeframe: metricWindow,
    holders: numeric(tokenX.holders),
    mcap: numeric(tokenX.market_cap) != null ? Math.round(Number(tokenX.market_cap)) : null,
    organic_score: null,
    token_age_hours: createdAt ? Math.floor((Date.now() - createdAt) / 3_600_000) : null,
    dev: tokenX.dev || null,
    launchpad: pool?.launchpad || null,
    active_positions: null,
    active_pct: null,
    open_positions: null,
    price: numeric(pool?.current_price),
    price_change_pct: null,
    price_trend: null,
    min_price: null,
    max_price: null,
    volume_change_pct: null,
    fee_change_pct: null,
    swap_count: null,
    unique_traders: null,
    official_raw: {
      apr: pool?.apr ?? null,
      apy: pool?.apy ?? null,
      has_farm: pool?.has_farm ?? null,
      is_blacklisted: pool?.is_blacklisted ?? null,
      tags: pool?.tags ?? [],
      metric_window: metricWindow,
    },
  };
}

function applyLocalSafetyFilter(pool, { requireOrganic = false, requireVolatility = false } = {}) {
  const s = config.screening;
  if (!pool?.pool) return "missing pool address";
  if (pool.official_raw?.is_blacklisted === true) return "official API blacklisted";
  if (isBlacklisted(pool.base?.mint)) return "local token blacklist";
  const dev = getDev(pool);
  if (dev && isDevBlocked(dev)) return "local dev blocklist";
  const blockedDevs = getBlockedDevs();
  if (dev && Object.keys(blockedDevs).length > 0 && blockedDevs[dev]) return "local dev blocklist";

  const launchpad = getLaunchpad(pool);
  if (Array.isArray(s.allowedLaunchpads) && s.allowedLaunchpads.length > 0 && launchpad && !includesCaseInsensitive(s.allowedLaunchpads, launchpad)) {
    return `launchpad ${launchpad} not in allow-list`;
  }
  if (includesCaseInsensitive(s.blockedLaunchpads, launchpad)) return `blocked launchpad ${launchpad}`;

  const mcap = numeric(pool.mcap);
  if (mcap == null || mcap < s.minMcap) return `mcap ${mcap ?? "unknown"} < ${s.minMcap}`;
  if (s.maxMcap != null && mcap > s.maxMcap) return `mcap ${mcap} > ${s.maxMcap}`;

  const holders = numeric(pool.holders);
  if (holders == null || holders < s.minHolders) return `holders ${holders ?? "unknown"} < ${s.minHolders}`;

  const volume = numeric(pool.volume_window);
  if (volume == null || volume < s.minVolume) return `volume ${volume ?? "unknown"} < ${s.minVolume}`;

  const tvl = numeric(pool.active_tvl ?? pool.tvl);
  if (tvl == null || tvl < s.minTvl) return `TVL ${tvl ?? "unknown"} < ${s.minTvl}`;
  if (s.maxTvl != null && tvl > s.maxTvl) return `TVL ${tvl} > ${s.maxTvl}`;

  const binStep = numeric(pool.bin_step);
  if (binStep == null || binStep < s.minBinStep) return `bin_step ${binStep ?? "unknown"} < ${s.minBinStep}`;
  if (binStep > s.maxBinStep) return `bin_step ${binStep} > ${s.maxBinStep}`;

  const feeActiveTvlRatio = numeric(pool.fee_active_tvl_ratio);
  if (feeActiveTvlRatio == null || feeActiveTvlRatio < s.minFeeActiveTvlRatio) {
    return `fee/active-TVL ${feeActiveTvlRatio ?? "unknown"} < ${s.minFeeActiveTvlRatio}`;
  }

  if (requireOrganic) {
    const organic = numeric(pool.organic_score ?? pool.base?.organic);
    if (organic == null || organic < s.minOrganic) return `organic ${organic ?? "unknown"} < ${s.minOrganic}`;
  }

  if (requireVolatility) {
    const volatility = numeric(pool.volatility);
    if (!(Number.isFinite(volatility) && volatility > 0)) return `volatility ${volatility ?? "unknown"} unusable`;
  }

  return null;
}

function collectRejectedSummary(rejected) {
  const counts = new Map();
  for (const entry of rejected) counts.set(entry.reason, (counts.get(entry.reason) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([reason, count]) => ({ reason, count }));
}

async function fetchOfficialPage({ page, pageSize, sortBy, ttlMs }) {
  const cacheKey = `official-dlmm-pools-${page}-${pageSize}-${sortBy}`;
  const cached = readCache(cacheKey, ttlMs);
  if (cached) return { ...cached, cache_hit: true };

  const params = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize),
  });
  if (sortBy) params.set("sort_by", sortBy);

  const url = `${OFFICIAL_DLMM_BASE}/pools?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Official DLMM pools API ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 160)}` : ""}`);
  }
  const data = await res.json();
  writeCache(cacheKey, data);
  return { ...data, cache_hit: false };
}

async function fetchPoolDiscoveryDetail({ poolAddress, timeframe, ttlMs }) {
  if (!poolAddress) return null;
  const cacheKey = `pool-discovery-detail-${timeframe}-${poolAddress}`;
  const cached = readCache(cacheKey, ttlMs);
  if (cached) return cached;

  const params = new URLSearchParams({
    page_size: "1",
    filter_by: `pool_address=${poolAddress}`,
    timeframe,
  });
  const res = await fetch(`${POOL_DISCOVERY_BASE}/pools?${params.toString()}`);
  if (!res.ok) throw new Error(`Pool discovery detail ${res.status} ${res.statusText}`);
  const data = await res.json();
  const detail = (data.data || [])[0] ?? null;
  if (detail) writeCache(cacheKey, detail);
  return detail;
}

function mergeDiscoveryDetail(pool, detail, { timeframe }) {
  if (!detail) return pool;
  const base = detail.token_x || {};
  const quote = detail.token_y || {};
  const volatility = numeric(detail.volatility);
  const organic = numeric(base.organic_score);
  const holders = numeric(detail.base_token_holders ?? base.holders);
  const mcap = numeric(base.market_cap);
  const binStep = numeric(detail.dlmm_params?.bin_step);
  return {
    ...pool,
    name: detail.name || pool.name,
    source_timeframe: timeframe || pool.source_timeframe,
    base: {
      ...pool.base,
      symbol: base.symbol || pool.base?.symbol,
      mint: base.address || pool.base?.mint,
      organic: organic != null ? Math.round(organic) : pool.base?.organic,
      warnings: Array.isArray(base.warnings) ? base.warnings.length : pool.base?.warnings,
    },
    quote: {
      ...pool.quote,
      symbol: quote.symbol || pool.quote?.symbol,
      mint: quote.address || pool.quote?.mint,
    },
    bin_step: binStep ?? pool.bin_step,
    fee_pct: numeric(detail.fee_pct) ?? pool.fee_pct,
    tvl: numeric(detail.tvl) != null ? Math.round(Number(detail.tvl)) : pool.tvl,
    active_tvl: numeric(detail.active_tvl) != null ? Math.round(Number(detail.active_tvl)) : pool.active_tvl,
    volatility: volatility != null ? round(volatility, 4) : pool.volatility,
    volatility_timeframe: detail.volatility_timeframe || timeframe || pool.volatility_timeframe,
    holders: holders ?? pool.holders,
    mcap: mcap != null ? Math.round(mcap) : pool.mcap,
    organic_score: organic != null ? Math.round(organic) : pool.organic_score,
    token_age_hours: base.created_at ? Math.floor((Date.now() - base.created_at) / 3_600_000) : pool.token_age_hours,
    dev: base.dev || pool.dev,
    launchpad: base.launchpad || detail.base_token_launchpad || detail.launchpad || pool.launchpad,
    active_positions: detail.active_positions ?? pool.active_positions,
    active_pct: numeric(detail.active_positions_pct) ?? pool.active_pct,
    open_positions: detail.open_positions ?? pool.open_positions,
    price: numeric(detail.pool_price) ?? pool.price,
    price_change_pct: numeric(detail.pool_price_change_pct) ?? pool.price_change_pct,
    price_trend: detail.price_trend ?? pool.price_trend,
    min_price: detail.min_price ?? pool.min_price,
    max_price: detail.max_price ?? pool.max_price,
    volume_change_pct: numeric(detail.volume_change_pct) ?? pool.volume_change_pct,
    fee_change_pct: numeric(detail.fee_change_pct) ?? pool.fee_change_pct,
    swap_count: detail.swap_count ?? pool.swap_count,
    unique_traders: detail.unique_traders ?? pool.unique_traders,
  };
}

async function enrichShortlist(pools, { timeframe, enrichLimit, delayMs, ttlMs }) {
  const shortlisted = pools.slice(0, enrichLimit);
  const enriched = [];
  const errors = [];
  for (const pool of shortlisted) {
    try {
      const detail = await fetchPoolDiscoveryDetail({ poolAddress: pool.pool, timeframe, ttlMs });
      enriched.push(mergeDiscoveryDetail(pool, detail, { timeframe }));
    } catch (error) {
      errors.push({ pool: pool.pool, name: pool.name, error: error.message });
      enriched.push(pool);
    }
    if (delayMs > 0) await sleep(delayMs);
  }
  return { enriched, errors };
}

export async function scanOfficialDlmmCandidates({
  limit = 10,
  timeframe = config.screening.timeframe || "1h",
  pageSize = DEFAULT_PAGE_SIZE,
  pages = DEFAULT_PAGES,
  sortBy = null,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  enrichLimit = DEFAULT_ENRICH_LIMIT,
  enrichDelayMs = DEFAULT_ENRICH_DELAY_MS,
} = {}) {
  const metricWindow = getMetricWindow(timeframe);
  const safePageSize = Math.max(1, Math.min(1000, Number(pageSize) || DEFAULT_PAGE_SIZE));
  const safePages = Math.max(1, Number(pages) || DEFAULT_PAGES);
  const effectiveSortBy = sortBy || `fee_tvl_ratio_${metricWindow}:desc`;

  const pagesData = [];
  for (let page = 1; page <= safePages; page++) {
    const pageData = await fetchOfficialPage({ page, pageSize: safePageSize, sortBy: effectiveSortBy, ttlMs: cacheTtlMs });
    pagesData.push(pageData);
    if (!Array.isArray(pageData.data) || pageData.data.length === 0) break;
    if (pageData.pages && page >= pageData.pages) break;
  }

  const rawPools = pagesData.flatMap((page) => Array.isArray(page.data) ? page.data : []);
  const normalized = rawPools.map((pool) => normalizeOfficialPool(pool, { metricWindow }));

  const firstPassRejected = [];
  const firstPass = [];
  for (const pool of normalized) {
    const reason = applyLocalSafetyFilter(pool, { requireOrganic: false, requireVolatility: false });
    if (reason) firstPassRejected.push({ name: pool.name, pool: pool.pool, reason });
    else firstPass.push(pool);
  }

  const rankedFirstPass = firstPass.sort((a, b) => scorePool(b) - scorePool(a));
  const { enriched, errors } = await enrichShortlist(rankedFirstPass, {
    timeframe,
    enrichLimit: Math.max(limit, enrichLimit),
    delayMs: enrichDelayMs,
    ttlMs: cacheTtlMs,
  });

  const finalRejected = [];
  const finalCandidates = [];
  for (const pool of enriched) {
    const reason = applyLocalSafetyFilter(pool, { requireOrganic: true, requireVolatility: true });
    if (reason) finalRejected.push({ name: pool.name, pool: pool.pool, reason });
    else finalCandidates.push(pool);
  }

  const candidates = finalCandidates
    .sort((a, b) => scorePool(b) - scorePool(a))
    .slice(0, limit);

  return {
    source: "official",
    candidates,
    filtered_examples: [...finalRejected, ...firstPassRejected].slice(0, 8),
    scan_summary: [
      {
        source: "official",
        base_url: OFFICIAL_DLMM_BASE,
        pages: pagesData.length,
        page_size: safePageSize,
        raw_count: rawPools.length,
        first_pass_count: firstPass.length,
        enriched_count: enriched.length,
        final_count: finalCandidates.length,
        returned_count: candidates.length,
        timeframe: metricWindow,
        sort_by: effectiveSortBy,
        cache_hits: pagesData.filter((page) => page.cache_hit).length,
        first_pass_reject_reasons: collectRejectedSummary(firstPassRejected),
        final_reject_reasons: collectRejectedSummary(finalRejected),
      },
    ],
    scan_errors: errors,
  };
}
