import "../envcrypt.js";
import { config } from "../config.js";
import { discoverPools, getTopCandidates } from "../tools/screening.js";
import { getMyPositions } from "../tools/dlmm.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../pool-memory.js";
import { isBlacklisted } from "../token-blacklist.js";
import { getBlockedDevs, isDevBlocked } from "../dev-blocklist.js";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const DATAPI_JUP = "https://datapi.jup.ag/v1";
const MIN_VOLATILITY_TIMEFRAME = "30m";
const TIMEFRAME_MINUTES = {
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "24h": 1440,
};

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function numeric(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fmt(value) {
  if (value == null) return "unknown";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
  return String(value);
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

function getPoolBaseMint(pool) {
  return pool?.token_x?.address ||
    pool?.base_token_address ||
    pool?.base_mint ||
    pool?.base?.mint ||
    null;
}

function getPoolDev(pool) {
  return pool?.token_x?.dev || pool?.base_token_dev || pool?.dev || null;
}

function getPoolName(pool) {
  return pool?.name || `${pool?.token_x?.symbol || "?"}-${pool?.token_y?.symbol || "?"}`;
}

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

function poolLabel(pool) {
  const address = pool?.pool_address || pool?.pool || "?";
  return `${getPoolName(pool)} (${String(address).slice(0, 8)})`;
}

function clonePool(pool) {
  return { ...pool, token_x: { ...(pool?.token_x || {}) }, token_y: { ...(pool?.token_y || {}) } };
}

async function fetchPoolDiscoveryPage({ pageSize, filterBy, timeframe, category }) {
  const params = new URLSearchParams({
    page_size: String(pageSize),
    timeframe,
    category,
  });
  if (filterBy) params.set("filter_by", filterBy);
  const res = await fetch(`${POOL_DISCOVERY_BASE}/pools?${params.toString()}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 160)}` : ""}`);
  }
  return res.json();
}

async function fetchPoolDiscoveryDetail({ poolAddress, timeframe }) {
  const params = new URLSearchParams({
    page_size: "1",
    filter_by: `pool_address=${poolAddress}`,
    timeframe,
  });
  const res = await fetch(`${POOL_DISCOVERY_BASE}/pools?${params.toString()}`);
  if (!res.ok) throw new Error(`Pool detail API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return (data.data || [])[0] ?? null;
}

async function applyVolatilityTimeframe(rawPools, sourceTimeframe) {
  const volatilityTimeframe = getVolatilityTimeframe(sourceTimeframe);
  const pools = rawPools.map(clonePool);
  for (const pool of pools) {
    pool[`volume_${sourceTimeframe}`] = pool.volume ?? null;
    pool[`volatility_${sourceTimeframe}`] = pool.volatility ?? null;
    pool.volatility_timeframe = volatilityTimeframe;
  }
  if (sourceTimeframe === volatilityTimeframe) return pools;

  const addresses = [...new Set(pools.map((pool) => pool?.pool_address).filter(Boolean))];
  const results = await Promise.allSettled(
    addresses.map((poolAddress) =>
      fetchPoolDiscoveryDetail({ poolAddress, timeframe: volatilityTimeframe })
        .then((pool) => ({ poolAddress, volatility: numeric(pool?.volatility), volume: numeric(pool?.volume) }))
    )
  );
  const byPool = new Map();
  for (const result of results) {
    if (result.status === "fulfilled") byPool.set(result.value.poolAddress, result.value);
  }
  for (const pool of pools) {
    const metrics = byPool.get(pool.pool_address);
    if (!metrics) continue;
    pool[`volume_${volatilityTimeframe}`] = metrics.volume;
    pool[`volatility_${volatilityTimeframe}`] = metrics.volatility;
    if (metrics.volatility != null) pool.volatility = metrics.volatility;
    if (metrics.volume != null) pool.volume = metrics.volume;
  }
  return pools;
}

async function fetchDevByMint(mint) {
  if (!mint) return null;
  const res = await fetch(`${DATAPI_JUP}/assets/search?query=${encodeURIComponent(mint)}`);
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const asset = Array.isArray(data) ? data.find((item) => item?.id === mint) || data[0] : data;
  return asset?.dev || null;
}

function summarizeRejected(rejected, limit = 5) {
  const reasonCounts = new Map();
  for (const item of rejected) {
    reasonCounts.set(item.reason, (reasonCounts.get(item.reason) || 0) + 1);
  }
  return {
    top_reasons: [...reasonCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([reason, count]) => ({ reason, count })),
    examples: rejected.slice(0, limit).map((item) => `${poolLabel(item.pool)} — ${item.reason}`),
  };
}

function applyStage(pools, label, rejectReasonFn) {
  const kept = [];
  const rejected = [];
  for (const pool of pools) {
    const reason = rejectReasonFn(pool);
    if (reason) rejected.push({ pool, reason });
    else kept.push(pool);
  }
  return {
    label,
    before: pools.length,
    after: kept.length,
    removed: rejected.length,
    ...summarizeRejected(rejected),
    pools: kept,
  };
}

function buildUpstreamApiFilter(s) {
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
    Array.isArray(s.allowedLaunchpads) && s.allowedLaunchpads.length > 0
      ? `base_token_launchpad=[${s.allowedLaunchpads.join(",")}]`
      : null,
  ].filter(Boolean).join("&&");
}

async function getOccupiedAndCooldownContext() {
  let positions = [];
  try {
    const result = await getMyPositions().catch(() => ({ positions: [] }));
    positions = Array.isArray(result?.positions) ? result.positions : [];
  } catch {
    positions = [];
  }
  return {
    occupiedPools: new Set(positions.map((p) => p.pool).filter(Boolean)),
    occupiedMints: new Set(positions.map((p) => p.base_mint).filter(Boolean)),
  };
}

function getCoreRejectReason(pool, s) {
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
  const createdAt = numeric(base?.created_at);

  if (s.excludeHighSupplyConcentration && pool?.base_token_has_high_supply_concentration === true) return "base high supply concentration";
  if (pool?.base_token_has_critical_warnings === true) return "base critical warnings";
  if (pool?.quote_token_has_critical_warnings === true) return "quote critical warnings";
  if (pool?.base_token_has_high_single_ownership === true) return "base high single ownership";
  if (pool?.pool_type && pool.pool_type !== "dlmm") return `pool_type ${pool.pool_type}`;
  if (mcap == null || mcap < s.minMcap) return `mcap ${fmt(mcap)} < ${s.minMcap}`;
  if (mcap > s.maxMcap) return `mcap ${fmt(mcap)} > ${s.maxMcap}`;
  if (holders == null || holders < s.minHolders) return `holders ${fmt(holders)} < ${s.minHolders}`;
  if (volume == null || volume < s.minVolume) return `volume ${fmt(volume)} < ${s.minVolume}`;
  if (tvl == null || tvl < s.minTvl) return `TVL ${fmt(tvl)} < ${s.minTvl}`;
  if (s.maxTvl != null && tvl > s.maxTvl) return `TVL ${fmt(tvl)} > ${s.maxTvl}`;
  if (binStep == null || binStep < s.minBinStep) return `bin_step ${fmt(binStep)} < ${s.minBinStep}`;
  if (binStep > s.maxBinStep) return `bin_step ${fmt(binStep)} > ${s.maxBinStep}`;
  if (feeActiveTvlRatio == null || feeActiveTvlRatio < s.minFeeActiveTvlRatio) return `fee/active-TVL ${fmt(feeActiveTvlRatio)} < ${s.minFeeActiveTvlRatio}`;
  if (!(Number.isFinite(volatility) && volatility > 0)) return `volatility ${fmt(volatility)} unusable`;
  if (baseOrganic == null || baseOrganic < s.minOrganic) return `base organic ${fmt(baseOrganic)} < ${s.minOrganic}`;
  if (quoteOrganic == null || quoteOrganic < s.minQuoteOrganic) return `quote organic ${fmt(quoteOrganic)} < ${s.minQuoteOrganic}`;
  if (Array.isArray(s.allowedLaunchpads) && s.allowedLaunchpads.length > 0 && launchpad && !includesCaseInsensitive(s.allowedLaunchpads, launchpad)) return `launchpad ${launchpad} not allowed`;
  if (includesCaseInsensitive(s.blockedLaunchpads, launchpad)) return `blocked launchpad ${launchpad}`;
  if (s.minTokenAgeHours != null) {
    const maxCreatedAt = Date.now() - s.minTokenAgeHours * 3_600_000;
    if (createdAt == null || createdAt > maxCreatedAt) return `age below ${s.minTokenAgeHours}h`;
  }
  if (s.maxTokenAgeHours != null) {
    const minCreatedAt = Date.now() - s.maxTokenAgeHours * 3_600_000;
    if (createdAt == null || createdAt < minCreatedAt) return `age above ${s.maxTokenAgeHours}h`;
  }
  return null;
}

async function main() {
  const pageSize = Number(argValue("page-size", "100"));
  const timeframe = argValue("timeframe", config.screening.timeframe || "5m");
  const category = argValue("category", config.screening.category || "trending");
  const json = hasFlag("json");
  const noVolNormalize = hasFlag("no-vol-normalize");
  const compareUpstream = !hasFlag("no-upstream");
  const enrichDev = hasFlag("enrich-dev");

  if (!Number.isFinite(pageSize) || pageSize <= 0) throw new Error("--page-size must be positive");

  // Let upstream discoverPools/getTopCandidates use the same CLI timeframe/category during this one process.
  config.screening.timeframe = timeframe;
  config.screening.category = category;

  const s = config.screening;
  const rawFilter = "pool_type=dlmm";
  const rawData = await fetchPoolDiscoveryPage({ pageSize, filterBy: rawFilter, timeframe, category });
  let pools = Array.isArray(rawData.data) ? rawData.data.map(clonePool) : [];
  const rawPoolCount = pools.length;

  if (!noVolNormalize) {
    pools = await applyVolatilityTimeframe(pools, timeframe);
  }

  const stages = [];
  const pushStage = (stage) => {
    stages.push(Object.fromEntries(Object.entries(stage).filter(([key]) => key !== "pools")));
    pools = stage.pools;
  };

  pushStage(applyStage(pools, "critical warnings / ownership", (pool) => {
    if (s.excludeHighSupplyConcentration && pool?.base_token_has_high_supply_concentration === true) return "base high supply concentration";
    if (pool?.base_token_has_critical_warnings === true) return "base critical warnings";
    if (pool?.quote_token_has_critical_warnings === true) return "quote critical warnings";
    if (pool?.base_token_has_high_single_ownership === true) return "base high single ownership";
    if (pool?.pool_type && pool.pool_type !== "dlmm") return `pool_type ${pool.pool_type}`;
    return null;
  }));

  pushStage(applyStage(pools, "market cap", (pool) => {
    const mcap = numeric(pool?.token_x?.market_cap);
    if (mcap == null || mcap < s.minMcap) return `mcap ${fmt(mcap)} < ${s.minMcap}`;
    if (mcap > s.maxMcap) return `mcap ${fmt(mcap)} > ${s.maxMcap}`;
    return null;
  }));

  pushStage(applyStage(pools, "holders", (pool) => {
    const holders = numeric(pool?.base_token_holders);
    if (holders == null || holders < s.minHolders) return `holders ${fmt(holders)} < ${s.minHolders}`;
    return null;
  }));

  pushStage(applyStage(pools, "volume", (pool) => {
    const volume = numeric(pool?.volume);
    if (volume == null || volume < s.minVolume) return `volume ${fmt(volume)} < ${s.minVolume}`;
    return null;
  }));

  pushStage(applyStage(pools, "TVL", (pool) => {
    const tvl = numeric(pool?.tvl ?? pool?.active_tvl);
    if (tvl == null || tvl < s.minTvl) return `TVL ${fmt(tvl)} < ${s.minTvl}`;
    if (s.maxTvl != null && tvl > s.maxTvl) return `TVL ${fmt(tvl)} > ${s.maxTvl}`;
    return null;
  }));

  pushStage(applyStage(pools, "bin step", (pool) => {
    const binStep = numeric(pool?.dlmm_params?.bin_step);
    if (binStep == null || binStep < s.minBinStep) return `bin_step ${fmt(binStep)} < ${s.minBinStep}`;
    if (binStep > s.maxBinStep) return `bin_step ${fmt(binStep)} > ${s.maxBinStep}`;
    return null;
  }));

  pushStage(applyStage(pools, "fee/active-TVL", (pool) => {
    const feeActiveTvlRatio = numeric(pool?.fee_active_tvl_ratio);
    if (feeActiveTvlRatio == null || feeActiveTvlRatio < s.minFeeActiveTvlRatio) return `fee/active-TVL ${fmt(feeActiveTvlRatio)} < ${s.minFeeActiveTvlRatio}`;
    return null;
  }));

  pushStage(applyStage(pools, "volatility", (pool) => {
    const volatility = numeric(pool?.volatility);
    if (!(Number.isFinite(volatility) && volatility > 0)) return `volatility ${fmt(volatility)} unusable`;
    return null;
  }));

  pushStage(applyStage(pools, "organic score", (pool) => {
    const baseOrganic = numeric(pool?.token_x?.organic_score);
    const quoteOrganic = numeric(pool?.token_y?.organic_score);
    if (baseOrganic == null || baseOrganic < s.minOrganic) return `base organic ${fmt(baseOrganic)} < ${s.minOrganic}`;
    if (quoteOrganic == null || quoteOrganic < s.minQuoteOrganic) return `quote organic ${fmt(quoteOrganic)} < ${s.minQuoteOrganic}`;
    return null;
  }));

  pushStage(applyStage(pools, "launchpad / token age", (pool) => {
    const launchpad = getPoolLaunchpad(pool);
    const createdAt = numeric(pool?.token_x?.created_at);
    if (Array.isArray(s.allowedLaunchpads) && s.allowedLaunchpads.length > 0 && launchpad && !includesCaseInsensitive(s.allowedLaunchpads, launchpad)) return `launchpad ${launchpad} not allowed`;
    if (includesCaseInsensitive(s.blockedLaunchpads, launchpad)) return `blocked launchpad ${launchpad}`;
    if (s.minTokenAgeHours != null) {
      const maxCreatedAt = Date.now() - s.minTokenAgeHours * 3_600_000;
      if (createdAt == null || createdAt > maxCreatedAt) return `age below ${s.minTokenAgeHours}h`;
    }
    if (s.maxTokenAgeHours != null) {
      const minCreatedAt = Date.now() - s.maxTokenAgeHours * 3_600_000;
      if (createdAt == null || createdAt < minCreatedAt) return `age above ${s.maxTokenAgeHours}h`;
    }
    return null;
  }));

  pushStage(applyStage(pools, "blacklist / dev blocklist", (pool) => {
    const mint = getPoolBaseMint(pool);
    const dev = getPoolDev(pool);
    if (isBlacklisted(mint)) return `blacklisted mint ${String(mint).slice(0, 8)}`;
    if (dev && isDevBlocked(dev)) return `blocked deployer ${String(dev).slice(0, 8)}`;
    return null;
  }));

  if (enrichDev && Object.keys(getBlockedDevs()).length > 0 && pools.length > 0) {
    const enriched = await Promise.all(pools.map(async (pool) => {
      if (getPoolDev(pool)) return pool;
      const dev = await fetchDevByMint(getPoolBaseMint(pool)).catch(() => null);
      if (dev) pool.token_x.dev = dev;
      return pool;
    }));
    pools = enriched;
    pushStage(applyStage(pools, "dev blocklist after Jupiter dev enrichment", (pool) => {
      const dev = getPoolDev(pool);
      if (dev && isDevBlocked(dev)) return `blocked deployer ${String(dev).slice(0, 8)}`;
      return null;
    }));
  }

  const { occupiedPools, occupiedMints } = await getOccupiedAndCooldownContext();
  pushStage(applyStage(pools, "occupied / cooldown", (pool) => {
    const poolAddress = pool?.pool_address;
    const mint = getPoolBaseMint(pool);
    if (occupiedPools.has(poolAddress)) return "already have position in pool";
    if (occupiedMints.has(mint)) return "already holding base mint";
    if (isPoolOnCooldown(poolAddress)) return "pool cooldown active";
    if (isBaseMintOnCooldown(mint)) return "token cooldown active";
    return null;
  }));

  let upstreamDiscover = null;
  let upstreamCandidates = null;
  if (compareUpstream) {
    upstreamDiscover = await discoverPools({ page_size: pageSize }).catch((error) => ({ error: error.message }));
    upstreamCandidates = await getTopCandidates({ limit: Number(argValue("limit", "10")) }).catch((error) => ({ error: error.message }));
  }

  const result = {
    config: {
      pageSize,
      timeframe,
      category,
      volatility_timeframe: getVolatilityTimeframe(timeframe),
      volatility_normalized: !noVolNormalize,
      thresholds: {
        minFeeActiveTvlRatio: s.minFeeActiveTvlRatio,
        minTvl: s.minTvl,
        maxTvl: s.maxTvl,
        minVolume: s.minVolume,
        minOrganic: s.minOrganic,
        minQuoteOrganic: s.minQuoteOrganic,
        minHolders: s.minHolders,
        minMcap: s.minMcap,
        maxMcap: s.maxMcap,
        minBinStep: s.minBinStep,
        maxBinStep: s.maxBinStep,
        minTokenFeesSol: s.minTokenFeesSol,
      },
    },
    raw: {
      api_total: rawData.total ?? null,
      sample_count: rawPoolCount,
      filter_by: rawFilter,
    },
    upstream_api_filter: buildUpstreamApiFilter(s),
    stages,
    local_final: {
      count: pools.length,
      examples: pools.slice(0, 10).map((pool) => ({
        name: getPoolName(pool),
        pool: pool.pool_address,
        mint: getPoolBaseMint(pool),
        fee_active_tvl_ratio: numeric(pool.fee_active_tvl_ratio),
        volume: numeric(pool.volume),
        tvl: numeric(pool.tvl ?? pool.active_tvl),
        volatility: numeric(pool.volatility),
        bin_step: numeric(pool.dlmm_params?.bin_step),
        holders: numeric(pool.base_token_holders),
        mcap: numeric(pool.token_x?.market_cap),
        organic: numeric(pool.token_x?.organic_score),
      })),
    },
    upstream_compare: compareUpstream ? {
      discoverPools: upstreamDiscover?.error ? { error: upstreamDiscover.error } : {
        total: upstreamDiscover?.total ?? null,
        pools_count: upstreamDiscover?.pools?.length ?? null,
        filtered_examples: upstreamDiscover?.filtered_examples ?? [],
      },
      getTopCandidates: upstreamCandidates?.error ? { error: upstreamCandidates.error } : {
        total_screened: upstreamCandidates?.total_screened ?? null,
        candidates_count: upstreamCandidates?.candidates?.length ?? null,
        filtered_examples: upstreamCandidates?.filtered_examples ?? [],
        candidates: (upstreamCandidates?.candidates || []).slice(0, 10).map((pool) => ({
          name: pool.name,
          pool: pool.pool,
          mint: pool.base?.mint,
          fee_active_tvl_ratio: pool.fee_active_tvl_ratio,
          volume_window: pool.volume_window,
          tvl: pool.tvl ?? pool.active_tvl,
          volatility: pool.volatility,
          bin_step: pool.bin_step,
        })),
      },
    } : null,
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("=== Meridian Screening Funnel Debugger ===\n");
  console.log(`Source sample: ${rawPoolCount}/${rawData.total ?? "?"} DLMM pools from category=${category} timeframe=${timeframe}`);
  console.log(`Volatility timeframe: ${result.config.volatility_timeframe}${noVolNormalize ? " (not normalized)" : " (normalized)"}`);
  console.log("\nThresholds:");
  console.log(JSON.stringify(result.config.thresholds, null, 2));

  console.log("\nFunnel:");
  for (const stage of stages) {
    console.log(`- ${stage.label}: ${stage.before} → ${stage.after} (removed ${stage.removed})`);
    for (const reason of stage.top_reasons) {
      console.log(`    ${reason.count}x ${reason.reason}`);
    }
    for (const example of stage.examples.slice(0, 3)) {
      console.log(`    e.g. ${example}`);
    }
  }

  console.log(`\nLocal final survivors: ${result.local_final.count}`);
  for (const pool of result.local_final.examples) {
    console.log(`- ${pool.name} pool=${String(pool.pool).slice(0, 8)} mint=${String(pool.mint).slice(0, 8)} fee/TVL=${fmt(pool.fee_active_tvl_ratio)} vol=${fmt(pool.volume)} tvl=${fmt(pool.tvl)} volatility=${fmt(pool.volatility)} bin=${fmt(pool.bin_step)}`);
  }

  if (compareUpstream) {
    console.log("\nUpstream comparison:");
    const d = result.upstream_compare.discoverPools;
    if (d.error) console.log(`discoverPools error: ${d.error}`);
    else console.log(`discoverPools: total=${d.total} pools=${d.pools_count}`);
    const t = result.upstream_compare.getTopCandidates;
    if (t.error) console.log(`getTopCandidates error: ${t.error}`);
    else {
      console.log(`getTopCandidates: total_screened=${t.total_screened} candidates=${t.candidates_count}`);
      for (const pool of t.candidates) {
        console.log(`- ${pool.name} pool=${String(pool.pool).slice(0, 8)} mint=${String(pool.mint).slice(0, 8)} fee/TVL=${fmt(pool.fee_active_tvl_ratio)} vol=${fmt(pool.volume_window)} tvl=${fmt(pool.tvl)} volatility=${fmt(pool.volatility)} bin=${fmt(pool.bin_step)}`);
      }
      if (t.filtered_examples?.length) {
        console.log("Filtered examples:");
        for (const entry of t.filtered_examples) console.log(`- ${entry.name}: ${entry.reason}`);
      }
    }
  }

  console.log("\nTip: run with --category=top or --timeframe=30m/1h to see whether the candidate bottleneck is category/timeframe-specific.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
