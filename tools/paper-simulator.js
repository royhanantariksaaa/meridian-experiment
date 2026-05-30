import fs from "fs";
import path from "path";
import { getTopCandidates, getPoolDetail } from "./screening.js";
import {
  buildDeterministicObservations,
  summarizeDeterministicDecisions,
} from "./screening-observer.js";

const PAPER_DIR = path.join(process.cwd(), "logs", "paper-sim");
const STATE_FILE = path.join(PAPER_DIR, "state.json");
const DEFAULT_BALANCE_SOL = 0.1;
const DEFAULT_ENTRY_SOL = 0.01;

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

export async function scanPaperCandidates({ limit = 10 } = {}) {
  const topCandidates = await getTopCandidates({ limit });
  const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, limit);
  const observations = buildDeterministicObservations(candidates);
  return {
    candidates,
    observations,
    summary: summarizeDeterministicDecisions(observations),
    filtered_examples: topCandidates?.filtered_examples ?? [],
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

export async function refreshPaperPosition(position, { timeframe = "5m" } = {}) {
  const detail = await getPoolDetail({ pool_address: position.pool, timeframe });
  const currentPrice = getPoolPrice(detail);
  const volumeActiveTvlRatio = getPoolVolumeActiveTvlRatio(detail);
  const feeActiveTvlRatio = maybeNumeric(detail?.fee_active_tvl_ratio);
  const priceChangeFromEntryPct = position.entry_price && currentPrice
    ? ((currentPrice - position.entry_price) / position.entry_price) * 100
    : null;
  const heldMinutes = Math.max(0, Math.floor((Date.now() - new Date(position.opened_at).getTime()) / 60_000));

  // This is deliberately labelled a proxy. Real DLMM fees depend on exact bins, swaps, inventory, and range crossing.
  const feeProxySol = feeActiveTvlRatio != null
    ? position.amount_sol * (feeActiveTvlRatio / 100)
    : null;

  const metrics = {
    checked_at: nowIso(),
    timeframe,
    held_minutes: heldMinutes,
    current_price: currentPrice,
    price_change_from_entry_pct: round(priceChangeFromEntryPct, 4),
    fee_active_tvl_ratio: feeActiveTvlRatio,
    volume: maybeNumeric(detail?.volume),
    active_tvl: maybeNumeric(detail?.active_tvl ?? detail?.tvl),
    volume_active_tvl_ratio: round(volumeActiveTvlRatio, 4),
    fee_proxy_sol: round(feeProxySol, 9),
  };

  return {
    ...position,
    last_check: {
      ...metrics,
      exit_signals: buildExitSignals({ position, metrics }),
    },
  };
}

export async function refreshPaperState({ timeframe = "5m" } = {}) {
  const state = loadPaperState();
  const refreshed = [];
  for (const position of state.open_positions) {
    try {
      refreshed.push(await refreshPaperPosition(position, { timeframe }));
    } catch (error) {
      refreshed.push({
        ...position,
        last_check: {
          checked_at: nowIso(),
          timeframe,
          error: error.message,
          exit_signals: ["refresh failed"],
        },
      });
    }
  }
  state.open_positions = refreshed;
  state.events.push({ ts: nowIso(), type: "REFRESH", timeframe, count: refreshed.length });
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

  const closed = {
    ...position,
    status: "CLOSED",
    closed_at: nowIso(),
    close_reason: reason,
    realized_pnl_sol: round(pnl, 9),
    returned_sol: round(position.amount_sol + pnl, 9),
  };

  state.closed_positions.push(closed);
  state.balance_sol = round(state.balance_sol + closed.returned_sol, 9);
  state.events.push({
    ts: nowIso(),
    type: "CLOSE",
    id,
    reason,
    realized_pnl_sol: closed.realized_pnl_sol,
    balance_sol: state.balance_sol,
  });
  saveState(state);
  return { state, closed };
}
