import fs from "fs";
import path from "path";
import { getPoolDetail } from "./screening.js";
import { scanCandidatePools } from "./paper-candidate-sources.js";
import {
  buildDeterministicObservations,
  summarizeDeterministicDecisions,
} from "./screening-observer.js";

const PAPER_DIR = path.join(process.cwd(), "logs", "paper-sim");
const STATE_FILE = path.join(PAPER_DIR, "state.json");
const DEFAULT_BALANCE_SOL = 0.1;
const DEFAULT_ENTRY_SOL = 0.01;

export const DEFAULT_PAPER_EXIT_RULES = Object.freeze({
  minHoldBeforeWeakExitMinutes: 10,
  forcedMaxHoldMinutes: 15,
  maxHoldMinutes: 60,
  minVolumeActiveTvlRatio: 1,
  minFeeActiveTvlRatio: 0.05,
  stopLossPct: -7,
  takeProfitFeeProxyPct: 2,
});

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function numeric(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function maybeNumeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 6) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(decimals)) : null;
}

function shortId(value) {
  return String(value || "unknown").slice(0, 8);
}

function mergeExitRules(exitRules = {}) {
  return {
    ...DEFAULT_PAPER_EXIT_RULES,
    ...Object.fromEntries(
      Object.entries(exitRules).filter(([, value]) => value != null && value !== ""),
    ),
  };
}

function resolvePaperRefreshTimeframe(position, fallback = "5m") {
  return position?.source_timeframe || fallback || "5m";
}

function blankState(balanceSol = DEFAULT_BALANCE_SOL) {
  const balance = numeric(balanceSol, DEFAULT_BALANCE_SOL);
  return {
    version: 1,
    starting_balance_sol: balance,
    balance_sol: balance,
    open_positions: [],
    closed_positions: [],
    events: [],
    created_at: nowIso(),
    last_updated: nowIso(),
  };
}

function saveState(state) {
  ensureDir(PAPER_DIR);
  state.last_updated = nowIso();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  return state;
}

export function resetPaperState(balanceSol = DEFAULT_BALANCE_SOL) {
  const state = blankState(balanceSol);
  state.events.push({ ts: nowIso(), type: "RESET", balance_sol: state.balance_sol });
  return saveState(state);
}

export function loadPaperState({ initialBalanceSol = DEFAULT_BALANCE_SOL } = {}) {
  ensureDir(PAPER_DIR);
  if (!fs.existsSync(STATE_FILE)) return resetPaperState(initialBalanceSol);
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return resetPaperState(initialBalanceSol);
  }
}

function estimateDownsideCoveragePct({ binStep, binsBelow }) {
  const step = numeric(binStep, 0) / 10_000;
  const bins = numeric(binsBelow, 0);
  if (step <= 0 || bins <= 0) return null;
  const lowerFactor = Math.pow(1 + step, -bins);
  return round((1 - lowerFactor) * 100, 4);
}

function getPoolPrice(pool) {
  return maybeNumeric(pool?.price ?? pool?.pool_price);
}

function getPoolVolumeActiveTvlRatio(pool) {
  const activeTvl = numeric(pool?.active_tvl ?? pool?.tvl, 0);
  const volume = numeric(pool?.volume_window ?? pool?.volume, 0);
  if (activeTvl <= 0) return 0;
  return volume / activeTvl;
}

function getFeeProxyPct(position) {
  const feeProxySol = maybeNumeric(position?.last_check?.fee_proxy_sol);
  const amount = numeric(position?.amount_sol, 0);
  if (feeProxySol == null || amount <= 0) return 0;
  return (feeProxySol / amount) * 100;
}

function estimatePaperPnlPct(position) {
  const feeProxyPct = getFeeProxyPct(position);
  const priceChange = maybeNumeric(position?.last_check?.price_change_from_entry_pct) ?? 0;
  const downsideInventoryProxy = Math.min(0, priceChange) * 0.35;
  return round(feeProxyPct + downsideInventoryProxy, 4);
}

function estimatePaperPnlFromMetrics({ amountSol, feeProxySol, priceChangePct }) {
  const amount = numeric(amountSol, 0);
  const feePct = amount > 0 ? (numeric(feeProxySol, 0) / amount) * 100 : 0;
  const downsideInventoryProxy = Math.min(0, numeric(priceChangePct, 0)) * 0.35;
  return {
    fee_proxy_pct: round(feePct, 4),
    estimated_inventory_pnl_pct: round(downsideInventoryProxy, 4),
    estimated_paper_pnl_pct: round(feePct + downsideInventoryProxy, 4),
    estimated_paper_pnl_sol: round(amount * ((feePct + downsideInventoryProxy) / 100), 9),
  };
}

function makeClosedPosition(position, { reason, pnlPct, auto = false } = {}) {
  const pct = maybeNumeric(pnlPct) ?? 0;
  const pnlSol = position.amount_sol * (pct / 100);
  return {
    ...position,
    status: "CLOSED",
    auto_closed: auto,
    closed_at: nowIso(),
    close_reason: reason,
    realized_pnl_pct: round(pct, 4),
    realized_pnl_sol: round(pnlSol, 9),
    returned_sol: round(position.amount_sol + pnlSol, 9),
  };
}

export async function scanPaperCandidates({ limit = 10, source = "auto" } = {}) {
  const scan = await scanCandidatePools({ source, limit });
  const candidates = (scan?.candidates || []).slice(0, limit);
  const observations = buildDeterministicObservations(candidates);
  return {
    source: scan?.source || source,
    candidates,
    observations,
    summary: summarizeDeterministicDecisions(observations),
    filtered_examples: scan?.filtered_examples ?? [],
    scan_summary: scan?.scan_summary ?? [],
    scan_errors: scan?.scan_errors ?? [],
  };
}

export function selectPaperCandidate(observations, {
  forceBest = false,
  allowAskLlm = true,
  allowAutoDeploy = true,
} = {}) {
  const ranked = [...(observations || [])]
    .sort((a, b) => numeric(b?.deterministic?.score) - numeric(a?.deterministic?.score));

  const eligible = ranked.filter((entry) => {
    const decision = entry?.deterministic?.decision;
    if (decision === "AUTO_DEPLOY_CANDIDATE") return allowAutoDeploy;
    if (decision === "ASK_LLM") return allowAskLlm;
    return false;
  });

  if (eligible.length > 0) return { entry: eligible[0], forced: false };
  if (forceBest && ranked.length > 0) return { entry: ranked[0], forced: true };
  return { entry: null, forced: false };
}

export function openPaperPosition({
  pool,
  deterministic,
  amountSol = DEFAULT_ENTRY_SOL,
  initialBalanceSol = DEFAULT_BALANCE_SOL,
  forced = false,
  note = null,
} = {}) {
  if (!pool || !deterministic) throw new Error("openPaperPosition requires pool and deterministic score data.");

  const amount = numeric(amountSol, DEFAULT_ENTRY_SOL);
  if (amount <= 0) throw new Error("Paper entry amount must be positive.");

  const state = loadPaperState({ initialBalanceSol });
  if (state.balance_sol < amount) {
    throw new Error(`Insufficient virtual SOL: balance ${state.balance_sol} < entry ${amount}`);
  }

  const id = `${Date.now()}-${shortId(pool.pool)}`;
  const price = getPoolPrice(pool);
  const volumeActiveTvlRatio = deterministic.metrics?.volume_active_tvl_ratio ?? getPoolVolumeActiveTvlRatio(pool);
  const downsideCoveragePct = estimateDownsideCoveragePct({
    binStep: pool.bin_step,
    binsBelow: deterministic.bins_below,
  });

  const position = {
    id,
    status: "OPEN",
    forced,
    note,
    opened_at: nowIso(),
    pool: pool.pool,
    pool_name: pool.name,
    base: pool.base,
    quote: pool.quote,
    source_timeframe: pool.source_timeframe ?? null,
    source_category: pool.source_category ?? null,
    amount_sol: amount,
    entry_price: price,
    entry_fee_active_tvl_ratio: deterministic.metrics?.fee_active_tvl_ratio ?? pool.fee_active_tvl_ratio ?? null,
    entry_volume_active_tvl_ratio: volumeActiveTvlRatio,
    entry_score: deterministic.score,
    entry_decision: deterministic.decision,
    entry_reason: deterministic.reason,
    bins_below: deterministic.bins_below,
    downside_coverage_pct: downsideCoveragePct,
    bin_step: pool.bin_step ?? null,
    last_check: null,
  };

  state.balance_sol = round(state.balance_sol - amount, 9);
  state.open_positions.push(position);
  state.events.push({
    ts: nowIso(),
    type: "OPEN",
    id,
    pool: pool.pool,
    pool_name: pool.name,
    amount_sol: amount,
    forced,
    decision: deterministic.decision,
    score: deterministic.score,
    source_timeframe: position.source_timeframe,
    source_category: position.source_category,
  });
  saveState(state);
  return { state, position };
}

function buildExitSignals({ position, metrics }) {
  const signals = [];
  if (metrics.volume_active_tvl_ratio < 1) signals.push("volume/activeTVL below 1x");
  if (metrics.fee_active_tvl_ratio != null && metrics.fee_active_tvl_ratio < 0.05) signals.push("fee/activeTVL below 0.05%");
  if (metrics.price_change_from_entry_pct != null && metrics.price_change_from_entry_pct <= -10) signals.push("price down 10%+ from paper entry");
  if (metrics.price_change_from_entry_pct != null && metrics.price_change_from_entry_pct <= -Number(position.downside_coverage_pct ?? 999)) {
    signals.push("price may be below simulated downside coverage");
  }
  if (position.forced) signals.push("forced entry was originally rejected by scorer");
  return signals;
}

export function getPaperAutoExit(position, exitRules = {}) {
  const rules = mergeExitRules(exitRules);
  const check = position?.last_check;
  if (!check || check.error) return null;

  const held = numeric(check.held_minutes, 0);
  const volumeRatio = numeric(check.volume_active_tvl_ratio, 0);
  const feeActiveTvl = maybeNumeric(check.fee_active_tvl_ratio);
  const priceChange = maybeNumeric(check.price_change_from_entry_pct);
  const feeProxyPct = getFeeProxyPct(position);
  const estimatedPnlPct = estimatePaperPnlPct(position);

  if (priceChange != null && priceChange <= rules.stopLossPct) {
    return { reason: `paper stop loss: price change ${priceChange}% <= ${rules.stopLossPct}%`, pnlPct: estimatedPnlPct };
  }
  if (priceChange != null && position.downside_coverage_pct != null && priceChange <= -Number(position.downside_coverage_pct)) {
    return { reason: `paper downside coverage breached: price change ${priceChange}% <= -${position.downside_coverage_pct}%`, pnlPct: estimatedPnlPct };
  }
  if (feeProxyPct >= rules.takeProfitFeeProxyPct && volumeRatio >= rules.minVolumeActiveTvlRatio) {
    return { reason: `paper take profit proxy: fee proxy ${round(feeProxyPct, 4)}% >= ${rules.takeProfitFeeProxyPct}%`, pnlPct: feeProxyPct };
  }
  if (position.forced && held >= rules.forcedMaxHoldMinutes && volumeRatio < rules.minVolumeActiveTvlRatio) {
    return { reason: `paper forced-entry exit: held ${held}m and volume/activeTVL ${volumeRatio}x < ${rules.minVolumeActiveTvlRatio}x`, pnlPct: estimatedPnlPct };
  }
  if (held >= rules.minHoldBeforeWeakExitMinutes && volumeRatio < rules.minVolumeActiveTvlRatio) {
    return { reason: `paper weak-volume exit: held ${held}m and volume/activeTVL ${volumeRatio}x < ${rules.minVolumeActiveTvlRatio}x`, pnlPct: estimatedPnlPct };
  }
  if (held >= rules.minHoldBeforeWeakExitMinutes && feeActiveTvl != null && feeActiveTvl < rules.minFeeActiveTvlRatio) {
    return { reason: `paper weak-fee exit: held ${held}m and fee/activeTVL ${feeActiveTvl}% < ${rules.minFeeActiveTvlRatio}%`, pnlPct: estimatedPnlPct };
  }
  if (held >= rules.maxHoldMinutes) {
    return { reason: `paper max-hold exit: held ${held}m >= ${rules.maxHoldMinutes}m`, pnlPct: estimatedPnlPct };
  }
  return null;
}

export async function refreshPaperPosition(position, { timeframe = "5m" } = {}) {
  const effectiveTimeframe = resolvePaperRefreshTimeframe(position, timeframe);
  const detail = await getPoolDetail({ pool_address: position.pool, timeframe: effectiveTimeframe });
  const currentPrice = getPoolPrice(detail);
  const volumeActiveTvlRatio = getPoolVolumeActiveTvlRatio(detail);
  const feeActiveTvlRatio = maybeNumeric(detail?.fee_active_tvl_ratio);
  const priceChangeFromEntryPct = position.entry_price && currentPrice
    ? ((currentPrice - position.entry_price) / position.entry_price) * 100
    : null;
  const heldMinutes = Math.max(0, Math.floor((Date.now() - new Date(position.opened_at).getTime()) / 60_000));
  const feeProxySol = feeActiveTvlRatio != null ? position.amount_sol * (feeActiveTvlRatio / 100) : null;
  const estimates = estimatePaperPnlFromMetrics({
    amountSol: position.amount_sol,
    feeProxySol,
    priceChangePct: priceChangeFromEntryPct,
  });

  const metrics = {
    checked_at: nowIso(),
    timeframe: effectiveTimeframe,
    configured_timeframe: timeframe,
    entry_timeframe: position.source_timeframe ?? null,
    held_minutes: heldMinutes,
    current_price: currentPrice,
    price_change_from_entry_pct: round(priceChangeFromEntryPct, 4),
    fee_active_tvl_ratio: feeActiveTvlRatio,
    volume: maybeNumeric(detail?.volume),
    active_tvl: maybeNumeric(detail?.active_tvl ?? detail?.tvl),
    volume_active_tvl_ratio: round(volumeActiveTvlRatio, 4),
    fee_proxy_sol: round(feeProxySol, 9),
    ...estimates,
  };

  return {
    ...position,
    last_check: {
      ...metrics,
      exit_signals: buildExitSignals({ position, metrics }),
    },
  };
}

export async function refreshPaperState({ timeframe = "5m", autoClose = false, exitRules = {} } = {}) {
  const state = loadPaperState();
  const refreshed = [];
  const autoClosed = [];

  for (const position of state.open_positions) {
    let nextPosition;
    const effectiveTimeframe = resolvePaperRefreshTimeframe(position, timeframe);
    try {
      nextPosition = await refreshPaperPosition(position, { timeframe });
    } catch (error) {
      nextPosition = {
        ...position,
        last_check: {
          checked_at: nowIso(),
          timeframe: effectiveTimeframe,
          configured_timeframe: timeframe,
          entry_timeframe: position.source_timeframe ?? null,
          error: error.message,
          exit_signals: ["refresh failed"],
        },
      };
    }

    const exit = autoClose ? getPaperAutoExit(nextPosition, exitRules) : null;
    if (exit) {
      const closed = makeClosedPosition(nextPosition, { reason: exit.reason, pnlPct: exit.pnlPct, auto: true });
      state.closed_positions.push(closed);
      state.balance_sol = round(state.balance_sol + closed.returned_sol, 9);
      state.events.push({
        ts: nowIso(),
        type: "AUTO_CLOSE",
        id: closed.id,
        reason: closed.close_reason,
        realized_pnl_pct: closed.realized_pnl_pct,
        realized_pnl_sol: closed.realized_pnl_sol,
        balance_sol: state.balance_sol,
        timeframe: closed.last_check?.timeframe ?? effectiveTimeframe,
      });
      autoClosed.push(closed);
    } else {
      refreshed.push(nextPosition);
    }
  }

  const effectiveTimeframes = [...new Set([...refreshed, ...autoClosed]
    .map((position) => position.last_check?.timeframe || position.source_timeframe)
    .filter(Boolean))];
  state.open_positions = refreshed;
  state.last_auto_closed = autoClosed;
  state.events.push({
    ts: nowIso(),
    type: "REFRESH",
    timeframe,
    effective_timeframes: effectiveTimeframes,
    count: refreshed.length,
    auto_closed: autoClosed.length,
  });
  saveState(state);
  return state;
}

export function closePaperPosition({ id, pnlSol = 0, pnlPct = null, reason = "manual close" } = {}) {
  const state = loadPaperState();
  const index = state.open_positions.findIndex((position) => position.id === id);
  if (index < 0) throw new Error(`Paper position ${id} not found.`);

  const [position] = state.open_positions.splice(index, 1);
  let pnl = maybeNumeric(pnlSol);
  if (pnl == null && pnlPct != null) pnl = position.amount_sol * (Number(pnlPct) / 100);
  if (pnl == null) pnl = 0;

  const closed = { ...position, status: "CLOSED", closed_at: nowIso(), close_reason: reason, realized_pnl_sol: round(pnl, 9), returned_sol: round(position.amount_sol + pnl, 9) };
  state.closed_positions.push(closed);
  state.balance_sol = round(state.balance_sol + closed.returned_sol, 9);
  state.events.push({ ts: nowIso(), type: "CLOSE", id, reason, realized_pnl_sol: closed.realized_pnl_sol, balance_sol: state.balance_sol });
  saveState(state);
  return { state, closed };
}
