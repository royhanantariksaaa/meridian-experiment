import { discoverPools, getTopCandidates } from "./screening.js";

const DEFAULT_MULTISCAN_TIMEFRAMES = ["5m", "30m", "1h", "2h", "4h"];
const DEFAULT_MULTISCAN_CATEGORIES = ["trending", "top", "new"];

function numeric(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function poolRankScore(pool) {
  const feeTvl = numeric(pool?.fee_active_tvl_ratio);
  const volume = numeric(pool?.volume_window);
  const activeTvl = numeric(pool?.active_tvl ?? pool?.tvl);
  const volActive = activeTvl > 0 ? volume / activeTvl : 0;
  const organic = numeric(pool?.organic_score ?? pool?.base?.organic);
  const holders = numeric(pool?.holders);
  return feeTvl * 1000 + volActive * 250 + organic * 10 + holders / 100;
}

function uniqueByPool(pools) {
  const byPool = new Map();
  for (const pool of pools || []) {
    if (!pool?.pool) continue;
    const existing = byPool.get(pool.pool);
    if (!existing || poolRankScore(pool) > poolRankScore(existing)) {
      byPool.set(pool.pool, pool);
    }
  }
  return [...byPool.values()];
}

export async function scanNormalCandidates({ limit = 10 } = {}) {
  const result = await getTopCandidates({ limit });
  const candidates = (result?.candidates || result?.pools || []).slice(0, limit);
  return {
    source: "normal",
    candidates,
    filtered_examples: result?.filtered_examples ?? [],
    scan_summary: [{ source: "normal", count: candidates.length, total_screened: result?.total_screened ?? null }],
  };
}

export async function scanMultiscanCandidates({
  limit = 10,
  pageSize = 50,
  timeframes = DEFAULT_MULTISCAN_TIMEFRAMES,
  categories = DEFAULT_MULTISCAN_CATEGORIES,
} = {}) {
  const scans = [];
  const errors = [];
  const allPools = [];

  for (const timeframe of timeframes) {
    for (const category of categories) {
      try {
        const scan = await discoverPools({ page_size: pageSize, timeframe, category });
        const pools = scan?.pools || [];
        allPools.push(...pools);
        scans.push({ timeframe, category, total: scan?.total ?? null, count: pools.length });
      } catch (error) {
        errors.push({ timeframe, category, error: error.message });
      }
    }
  }

  const candidates = uniqueByPool(allPools)
    .sort((a, b) => poolRankScore(b) - poolRankScore(a))
    .slice(0, limit);

  return {
    source: "multiscan",
    candidates,
    filtered_examples: errors.slice(0, 5),
    scan_summary: scans,
    scan_errors: errors,
  };
}

export async function scanCandidatePools({ source = "auto", limit = 10 } = {}) {
  if (source === "normal") return scanNormalCandidates({ limit });
  if (source === "multiscan") return scanMultiscanCandidates({ limit });

  const normal = await scanNormalCandidates({ limit }).catch((error) => ({
    source: "normal",
    candidates: [],
    filtered_examples: [{ name: "normal", reason: error.message }],
    scan_summary: [{ source: "normal", error: error.message }],
  }));
  if ((normal.candidates || []).length > 0) return { ...normal, source: "auto:normal" };

  const multi = await scanMultiscanCandidates({ limit });
  return {
    ...multi,
    source: "auto:multiscan",
    filtered_examples: [...(normal.filtered_examples || []), ...(multi.filtered_examples || [])].slice(0, 8),
    scan_summary: [...(normal.scan_summary || []), ...(multi.scan_summary || [])],
  };
}
