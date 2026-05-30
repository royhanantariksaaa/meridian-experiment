import { config } from "../config.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../pool-memory.js";
import { log } from "../logger.js";

const DATAPI_JUP = "https://datapi.jup.ag/v1";
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const VALID_TIMEFRAMES = new Set(["5m", "30m", "1h", "2h", "4h", "12h", "24h"]);

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

function scoreCandidate(pool) {
  const feeTvl = Number(pool.fee_active_tvl_ratio || 0);
  const organic = Number(pool.organic_score || pool.base?.organic || 0);
  const volume = Number(pool.volume_window || 0);
  const holders = Number(pool.holders || 0);
  return feeTvl * 1000 + organic * 10 + volume / 100 + holders / 100;
}

function getPoolLaunchpad(pool) {
  const base = pool?.token_x || {};
  return base?.launchpad || base?.launchpad_platform || pool?.base_token_launchpad || pool?.launchpad || pool?.launchpad_platform || null;
}

function buildFilters(s) {
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
    s.maxTvl != null ? `tvl<=${s.maxTvl}` : null,
    `dlmm_bin_step>=${s.minBinStep}`,
    `dlmm_bin_step<=${s.maxBinStep}`,
    `fee_active_tvl_ratio>=${s.minFeeActiveTvlRatio}`,
    `base_token_organic_score>=${s.minOrganic}`,
    `quote_token_organic_score>=${s.minQuoteOrganic}`,
    s.minTokenAgeHours != null ? `base_token_created_at<=${Date.now() - s.minTokenAgeHours * 3_600_000}` : null,
    s.maxTokenAgeHours != null ? `base_token_created_at>=${Date.now() - s.maxTokenAgeHours * 3_600_000}` : null,
  ].filter(Boolean).join("&&");
}

function condensePool(p, { timeframe, category } = {}) {
  return {
    pool: p.pool_address,
    name: p.name,
    source_timeframe: timeframe || null,
    source_category: category || null,
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
    volatility_timeframe: timeframe || null,
    holders: p.base_token_holders,
    mcap: round(p.token_x?.market_cap),
    organic_score: Math.round(p.token_x?.organic_score || 0),
    token_age_hours: p.token_x?.created_at ? Math.floor((Date.now() - p.token_x.created_at) / 3_600_000) : null,
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
    pool_score: scoreCandidate({
      fee_active_tvl_ratio: p.fee_active_tvl_ratio,
      organic_score: p.token_x?.organic_score,
      volume_window: p.volume,
      holders: p.base_token_holders,
    }),
  };
}

async function fetchPoolDiscoveryPage({ page_size, filters, timeframe, category }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=${page_size}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=${encodeURIComponent(timeframe)}` +
    `&category=${encodeURIComponent(category)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 160)}` : ""}`);
  }
  return res.json();
}

async function fetchPoolDiscoveryDetail({ poolAddress, timeframe }) {
  const safeTimeframe = VALID_TIMEFRAMES.has(timeframe) ? timeframe : "5m";
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}` +
    `&timeframe=${encodeURIComponent(safeTimeframe)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool detail API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return (data.data || [])[0] ?? null;
}

export async function discoverPools({ page_size = 50, timeframe = config.screening.timeframe, category = config.screening.category } = {}) {
  const safeTimeframe = VALID_TIMEFRAMES.has(timeframe) ? timeframe : config.screening.timeframe || "5m";
  const safeCategory = category || config.screening.category || "trending";
  const data = await fetchPoolDiscoveryPage({
    page_size,
    filters: buildFilters(config.screening),
    timeframe: safeTimeframe,
    category: safeCategory,
  });
  const rawPools = Array.isArray(data.data) ? data.data : [];
  const pools = rawPools.map((pool) => condensePool(pool, { timeframe: safeTimeframe, category: safeCategory }));
  return {
    total: data.total ?? rawPools.length,
    pools,
    filtered_examples: [],
    timeframe: safeTimeframe,
    category: safeCategory,
  };
}

export async function getTopCandidates({ limit = 10 } = {}) {
  const discovery = await discoverPools({ page_size: 50 });
  let positions = [];
  try {
    const { getMyPositions } = await import("./dlmm.js");
    const result = await getMyPositions().catch(() => ({ positions: [] }));
    positions = Array.isArray(result?.positions) ? result.positions : [];
  } catch {
    positions = [];
  }
  const occupiedPools = new Set(positions.map((p) => p.pool));
  const occupiedMints = new Set(positions.map((p) => p.base_mint).filter(Boolean));
  const eligible = discovery.pools
    .filter((p) => !occupiedPools.has(p.pool))
    .filter((p) => !(p.base?.mint && occupiedMints.has(p.base.mint)))
    .filter((p) => !isPoolOnCooldown(p.pool))
    .filter((p) => !isBaseMintOnCooldown(p.base?.mint))
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
    .slice(0, limit);

  if (eligible.length > 0) {
    try {
      const { getAdvancedInfo, getPriceInfo, getClusterList, getRiskFlags } = await import("./okx.js");
      const okxResults = await Promise.allSettled(
        eligible.map(async (p) => {
          if (!p.base?.mint) return { adv: null, price: null, clusters: [], risk: null };
          const [adv, price, clusters, risk] = await Promise.allSettled([
            getAdvancedInfo(p.base.mint),
            getPriceInfo(p.base.mint),
            getClusterList(p.base.mint),
            getRiskFlags(p.base.mint),
          ]);
          const mintShort = p.base.mint.slice(0, 8);
          if (adv.status !== "fulfilled") log("okx", `advanced-info unavailable for ${p.name} (${mintShort})`);
          if (price.status !== "fulfilled") log("okx", `price-info unavailable for ${p.name} (${mintShort})`);
          return {
            adv: adv.status === "fulfilled" ? adv.value : null,
            price: price.status === "fulfilled" ? price.value : null,
            clusters: clusters.status === "fulfilled" ? clusters.value : [],
            risk: risk.status === "fulfilled" ? risk.value : null,
          };
        })
      );
      for (let i = 0; i < eligible.length; i++) {
        const r = okxResults[i];
        if (r.status !== "fulfilled") continue;
        const { adv, price, clusters, risk } = r.value;
        if (adv) {
          eligible[i].risk_level = adv.risk_level;
          eligible[i].bundle_pct = adv.bundle_pct;
          eligible[i].sniper_pct = adv.sniper_pct;
          eligible[i].suspicious_pct = adv.suspicious_pct;
          eligible[i].smart_money_buy = adv.smart_money_buy;
          eligible[i].dev_sold_all = adv.dev_sold_all;
          if (adv.creator && !eligible[i].dev) eligible[i].dev = adv.creator;
        }
        if (risk) {
          eligible[i].is_rugpull = risk.is_rugpull;
          eligible[i].is_wash = risk.is_wash;
        }
        if (price) {
          eligible[i].price_vs_ath_pct = price.price_vs_ath_pct;
          eligible[i].ath = price.ath;
        }
        if (clusters?.length) {
          eligible[i].kol_in_clusters = clusters.some((c) => c.has_kol);
          eligible[i].top_cluster_trend = clusters[0]?.trend ?? null;
          eligible[i].top_cluster_hold_pct = clusters[0]?.holding_pct ?? null;
        }
      }
    } catch (error) {
      log("okx", `OKX enrichment skipped: ${error.message}`);
    }
  }

  return {
    candidates: eligible.filter((p) => !p.is_wash),
    total_screened: discovery.pools.length,
    filtered_examples: [],
  };
}

export async function getPoolDetail({ pool_address, timeframe = "5m" }) {
  const pool = await fetchPoolDiscoveryDetail({ poolAddress: pool_address, timeframe });
  if (!pool) throw new Error(`Pool ${pool_address} not found`);
  return pool;
}
