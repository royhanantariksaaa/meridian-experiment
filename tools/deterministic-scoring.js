import { config, MIN_SAFE_BINS_BELOW } from "../config.js";

export const DETERMINISTIC_DECISIONS = Object.freeze({
  AUTO_SKIP: "AUTO_SKIP",
  ASK_LLM: "ASK_LLM",
  AUTO_DEPLOY_CANDIDATE: "AUTO_DEPLOY_CANDIDATE",
});

const DEFAULT_MIN_VOLUME_ACTIVE_TVL_FOR_LLM = 1.0;
const DEFAULT_MIN_VOLUME_ACTIVE_TVL_FOR_AUTO_DEPLOY = 3.0;

function numeric(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function maybeNumeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function pctOverLimitPenalty(value, limit, maxPenalty) {
  const v = maybeNumeric(value);
  const l = maybeNumeric(limit);
  if (v == null || l == null || l <= 0 || v <= l) return 0;
  return clamp((v - l) / l, 0, 1) * maxPenalty;
}

function booleanPenalty(flag, penalty) {
  return flag === true ? penalty : 0;
}

function shortId(value) {
  return value ? String(value).slice(0, 8) : "????????";
}

function getTvl(pool) {
  return numeric(pool.active_tvl ?? pool.tvl, 0);
}

function getVolume(pool) {
  return numeric(pool.volume_window ?? pool.volume, 0);
}

function hasSmartWalletSignal(pool) {
  return pool.smart_wallet_buy === true ||
    pool.smart_wallets_present === true ||
    numeric(pool.smart_wallet_count, 0) > 0 ||
    numeric(pool.smart_wallets_count, 0) > 0 ||
    numeric(pool.sw?.in_pool?.length, 0) > 0 ||
    (Array.isArray(pool.smart_wallets) && pool.smart_wallets.length > 0) ||
    (Array.isArray(pool.in_pool) && pool.in_pool.length > 0);
}

export function calculateVolumeActiveTvlRatio(pool) {
  const activeTvl = getTvl(pool);
  if (activeTvl <= 0) return 0;
  return getVolume(pool) / activeTvl;
}

export function calculateBinsBelow(
  volatility,
  minBins = config.strategy.minBinsBelow,
  maxBins = config.strategy.maxBinsBelow,
) {
  const v = maybeNumeric(volatility);
  if (v == null || v <= 0) return null;

  const min = Math.max(MIN_SAFE_BINS_BELOW, Math.round(numeric(minBins, MIN_SAFE_BINS_BELOW)));
  const max = Math.max(min, Math.round(numeric(maxBins, min)));
  const raw = min + (v / 5) * (max - min);
  return Math.round(clamp(raw, min, max));
}

function scoreTrend(pool) {
  const volumeChange = maybeNumeric(pool.volume_change_pct);
  const feeChange = maybeNumeric(pool.fee_change_pct);
  const priceChange = maybeNumeric(pool.price_change_pct);

  let score = 0.5;
  if (volumeChange != null) score += clamp(volumeChange / 200, -0.25, 0.25);
  if (feeChange != null) score += clamp(feeChange / 200, -0.2, 0.2);
  if (priceChange != null) {
    // Mildly reward positive movement, but penalize extremely sharp pumps.
    if (priceChange > 80) score -= 0.25;
    else score += clamp(priceChange / 200, -0.15, 0.15);
  }
  return clamp(score, 0, 1);
}

function scoreVolatilityFit(volatility) {
  const v = maybeNumeric(volatility);
  if (v == null || v <= 0) return 0;

  // DLMM wants movement, but extreme volatility is dangerous for single-sided LP.
  // Peak around 3-4; still acceptable up to around 8.
  if (v <= 4) return clamp(v / 4, 0.2, 1);
  if (v <= 8) return clamp(1 - ((v - 4) / 8), 0.45, 1);
  return clamp(0.45 - ((v - 8) / 20), 0.1, 0.45);
}

function collectHardFlags(pool, options) {
  const s = options.screening ?? config.screening;
  const flags = [];
  const botPct = maybeNumeric(pool.bot_holders_pct ?? pool.audit?.bot_holders_pct);
  const feesSol = maybeNumeric(pool.fees_sol ?? pool.global_fees_sol);
  const volatility = maybeNumeric(pool.volatility);
  const launchpad = pool.launchpad;

  // Match upstream prompt semantics:
  // - wash, unusable volatility, bot-holder excess, low token fees, and blocked launchpads are hard skips.
  // - rugpull is default-skip unless smart wallets are present.
  // - top10 concentration is a risk penalty, not a hard skip.
  if (pool.is_wash === true) flags.push("wash trading flagged");
  if (pool.is_rugpull === true && !hasSmartWalletSignal(pool)) flags.push("rugpull flagged with no smart-wallet override");
  if (volatility == null || volatility <= 0) flags.push("unusable volatility");
  if (botPct != null && s.maxBotHoldersPct != null && botPct > s.maxBotHoldersPct) {
    flags.push(`bot holders ${botPct}% > ${s.maxBotHoldersPct}%`);
  }
  if (feesSol != null && s.minTokenFeesSol != null && feesSol < s.minTokenFeesSol) {
    flags.push(`token fees ${feesSol} SOL < ${s.minTokenFeesSol} SOL`);
  }
  if (launchpad && Array.isArray(s.blockedLaunchpads) && s.blockedLaunchpads.includes(launchpad)) {
    flags.push(`blocked launchpad ${launchpad}`);
  }
  return flags;
}

function collectPenalties(pool, options) {
  const s = options.screening ?? config.screening;
  const penalties = [];
  const add = (name, value) => {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) penalties.push({ name, value: Number(n.toFixed(2)) });
  };

  add("pvp_risk", pool.is_pvp ? 14 : 0);
  add("wash", booleanPenalty(pool.is_wash, 100));
  add("rugpull", booleanPenalty(pool.is_rugpull, hasSmartWalletSignal(pool) ? 45 : 70));
  add("bundle_pct", pctOverLimitPenalty(pool.bundle_pct, s.maxBundlePct, 15));
  add("sniper_pct", pctOverLimitPenalty(pool.sniper_pct, 35, 10));
  add("suspicious_pct", pctOverLimitPenalty(pool.suspicious_pct, 25, 18));
  add("bot_holders_pct", pctOverLimitPenalty(pool.bot_holders_pct ?? pool.audit?.bot_holders_pct, s.maxBotHoldersPct, 25));
  add("top10_pct", pctOverLimitPenalty(pool.top10_pct ?? pool.top_holders_pct ?? pool.audit?.top_holders_pct, s.maxTop10Pct, 25));

  const priceVsAth = maybeNumeric(pool.price_vs_ath_pct);
  if (priceVsAth != null && priceVsAth > 90) add("near_ath", 8);
  if (priceVsAth != null && priceVsAth > 110) add("above_ath", 16);

  const ageHours = maybeNumeric(pool.token_age_hours);
  if (ageHours != null && ageHours > 72) add("old_pool", 4);

  return penalties;
}

function scoreSmartWalletSignal(pool) {
  if (!hasSmartWalletSignal(pool)) return 0;
  return 5;
}

export function scoreDeterministicCandidate(pool, options = {}) {
  const feeActiveTvlRatio = numeric(pool.fee_active_tvl_ratio, 0);
  const volumeActiveTvlRatio = calculateVolumeActiveTvlRatio(pool);
  const organic = numeric(pool.organic_score ?? pool.base?.organic, 0);
  const holders = numeric(pool.holders, 0);
  const uniqueTraders = numeric(pool.unique_traders, 0);
  const swapCount = numeric(pool.swap_count, 0);
  const volatility = numeric(pool.volatility, 0);

  const components = {
    fee_efficiency: clamp(feeActiveTvlRatio / 0.5) * 20,
    volume_efficiency: clamp(volumeActiveTvlRatio / 10) * 25,
    activity: ((clamp(uniqueTraders / 100) * 0.55) + (clamp(swapCount / 250) * 0.45)) * 12,
    organic: clamp(organic / 100) * 10,
    holders: clamp(holders / 3000) * 8,
    volatility_fit: scoreVolatilityFit(volatility) * 10,
    trend: scoreTrend(pool) * 5,
    smart_wallet_signal: scoreSmartWalletSignal(pool),
    safety_baseline: 10,
  };

  const rawPositiveScore = Object.values(components).reduce((sum, value) => sum + value, 0);
  const penalties = collectPenalties(pool, options);
  const penaltyTotal = penalties.reduce((sum, entry) => sum + entry.value, 0);
  const hardFlags = collectHardFlags(pool, options);
  const score = Math.round(clamp(rawPositiveScore - penaltyTotal, 0, 100));

  const autoDeployScore = numeric(options.autoDeployScore ?? 85, 85);
  const askLlmScore = numeric(options.askLlmScore ?? 65, 65);
  const minVolumeActiveTvlForLlm = numeric(
    options.minVolumeActiveTvlForLlm ?? DEFAULT_MIN_VOLUME_ACTIVE_TVL_FOR_LLM,
    DEFAULT_MIN_VOLUME_ACTIVE_TVL_FOR_LLM,
  );
  const minVolumeActiveTvlForAutoDeploy = numeric(
    options.minVolumeActiveTvlForAutoDeploy ?? DEFAULT_MIN_VOLUME_ACTIVE_TVL_FOR_AUTO_DEPLOY,
    DEFAULT_MIN_VOLUME_ACTIVE_TVL_FOR_AUTO_DEPLOY,
  );
  let decision = DETERMINISTIC_DECISIONS.AUTO_SKIP;
  let reason = "score below LLM-review threshold";

  if (hardFlags.length > 0) {
    decision = DETERMINISTIC_DECISIONS.AUTO_SKIP;
    reason = `hard flag: ${hardFlags[0]}`;
  } else if (volumeActiveTvlRatio < minVolumeActiveTvlForLlm) {
    decision = DETERMINISTIC_DECISIONS.AUTO_SKIP;
    reason = `volume/activeTVL ${volumeActiveTvlRatio.toFixed(4)}x below LLM threshold ${minVolumeActiveTvlForLlm}x`;
  } else if (score >= autoDeployScore && volumeActiveTvlRatio >= minVolumeActiveTvlForAutoDeploy) {
    decision = DETERMINISTIC_DECISIONS.AUTO_DEPLOY_CANDIDATE;
    reason = `score ${score} >= ${autoDeployScore} and volume/activeTVL ${volumeActiveTvlRatio.toFixed(4)}x >= ${minVolumeActiveTvlForAutoDeploy}x`;
  } else if (score >= askLlmScore) {
    decision = DETERMINISTIC_DECISIONS.ASK_LLM;
    reason = `score ${score} is in gray zone ${askLlmScore}-${autoDeployScore - 1}`;
  }

  return {
    pool: pool.pool,
    name: pool.name,
    base_symbol: pool.base?.symbol,
    base_mint: pool.base?.mint,
    score,
    decision,
    reason,
    bins_below: calculateBinsBelow(pool.volatility),
    metrics: {
      fee_active_tvl_ratio: feeActiveTvlRatio,
      volume_active_tvl_ratio: Number(volumeActiveTvlRatio.toFixed(4)),
      volume_window: getVolume(pool),
      active_tvl: getTvl(pool),
      organic_score: organic,
      holders,
      volatility,
      unique_traders: uniqueTraders,
      swap_count: swapCount,
      smart_wallet_signal: hasSmartWalletSignal(pool),
    },
    thresholds: {
      ask_llm_score: askLlmScore,
      auto_deploy_score: autoDeployScore,
      min_volume_active_tvl_for_llm: minVolumeActiveTvlForLlm,
      min_volume_active_tvl_for_auto_deploy: minVolumeActiveTvlForAutoDeploy,
    },
    components: Object.fromEntries(
      Object.entries(components).map(([key, value]) => [key, Number(value.toFixed(2))]),
    ),
    penalties,
    hard_flags: hardFlags,
  };
}

export function rankDeterministicCandidates(candidates, options = {}) {
  return (candidates || [])
    .map((pool) => ({ pool, deterministic: scoreDeterministicCandidate(pool, options) }))
    .sort((a, b) => b.deterministic.score - a.deterministic.score);
}

export function formatDeterministicCandidateLine(entry, index = 0) {
  const d = entry.deterministic ?? entry;
  const p = entry.pool ?? {};
  const name = d.name || p.name || "unknown";
  const poolAddress = d.pool || p.pool || null;
  const baseMint = d.base_mint || p.base?.mint || null;
  const ratio = d.metrics?.volume_active_tvl_ratio ?? 0;
  const fee = d.metrics?.fee_active_tvl_ratio ?? 0;
  const bins = d.bins_below ?? "?";
  return `${String(index + 1).padStart(2, " ")}. ${name} [pool=${shortId(poolAddress)} mint=${shortId(baseMint)}] | score=${d.score} | ${d.decision} | fee/TVL=${fee}% | vol/activeTVL=${ratio}x | bins_below=${bins} | ${d.reason}`;
}
