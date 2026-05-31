import fs from "fs";
import path from "path";
import {
  DEFAULT_PAPER_EXIT_RULES,
  loadPaperState,
  openPaperPosition,
  refreshPaperState,
  resetPaperState,
  scanPaperCandidates,
  selectPaperCandidate,
} from "../tools/paper-simulator.js";
import { formatDeterministicCandidateLine } from "../tools/deterministic-scoring.js";

const RUNTIME_DIR = path.join(process.cwd(), "logs", "paper-sim");
const RUNTIME_FILE = path.join(RUNTIME_DIR, "runtime.json");

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatSol(value) {
  const n = Number(value || 0);
  return `${n.toFixed(4)} SOL`;
}

function writeRuntime(patch = {}) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(RUNTIME_FILE, "utf8"));
  } catch {
    current = {};
  }
  const next = {
    ...current,
    ...patch,
    pid: process.pid,
    heartbeat_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify(next, null, 2));
  return next;
}

function argNumber(name, fallback) {
  return Number(argValue(name, fallback));
}

function buildExitRules({ forceBest = false } = {}) {
  const forcedDefaults = forceBest
    ? {
        minHoldBeforeWeakExitMinutes: 5,
        forcedMaxHoldMinutes: 15,
        maxHoldMinutes: 15,
        stopLossPct: -4,
        takeProfitFeeProxyPct: 1.5,
      }
    : {};
  const defaults = {
    ...DEFAULT_PAPER_EXIT_RULES,
    ...forcedDefaults,
  };
  return {
    ...defaults,
    minHoldBeforeWeakExitMinutes: argNumber("weak-exit-min", defaults.minHoldBeforeWeakExitMinutes),
    forcedMaxHoldMinutes: argNumber("forced-max-hold", defaults.forcedMaxHoldMinutes),
    maxHoldMinutes: argNumber("max-hold", defaults.maxHoldMinutes),
    minVolumeActiveTvlRatio: argNumber("min-vol-ratio", defaults.minVolumeActiveTvlRatio),
    minFeeActiveTvlRatio: argNumber("min-fee-tvl", defaults.minFeeActiveTvlRatio),
    stopLossPct: argNumber("stop-loss", defaults.stopLossPct),
    takeProfitFeeProxyPct: argNumber("take-profit", defaults.takeProfitFeeProxyPct),
    paperEntryCostPct: argNumber("paper-entry-cost", defaults.paperEntryCostPct),
    paperExitCostPct: argNumber("paper-exit-cost", defaults.paperExitCostPct),
    paperSlippagePct: argNumber("paper-slippage", defaults.paperSlippagePct),
  };
}

function printStateCompact(state, { showAutoClosed = false } = {}) {
  console.log(`Virtual balance: ${formatSol(state.balance_sol)} | open=${state.open_positions.length} | closed=${state.closed_positions.length}`);

  if (showAutoClosed && state.last_auto_closed?.length) {
    console.log("AUTO-CLOSED THIS CYCLE");
    for (const position of state.last_auto_closed) {
      console.log(`- ${position.id} | ${position.pool_name} | pnl=${position.realized_pnl_pct}% (${position.realized_pnl_sol} SOL) | reason=${position.close_reason}`);
    }
  }

  for (const position of state.open_positions) {
    console.log(`- ${position.id} | ${position.pool_name} | ${position.amount_sol} SOL | score=${position.entry_score} | ${position.entry_decision}`);
    if (position.last_check) {
      const check = position.last_check;
      console.log(`  held=${check.held_minutes}m | vol/activeTVL=${check.volume_active_tvl_ratio}x | fee/TVL=${check.fee_active_tvl_ratio}% | price_change=${check.price_change_from_entry_pct}% | est_pnl=${check.estimated_paper_pnl_pct}% | fee_proxy=${check.fee_proxy_sol} SOL | friction=${check.execution_cost_pct ?? 0}%`);
      console.log(`  exit_signals=${check.exit_signals?.length ? check.exit_signals.join("; ") : "none"}`);
    }
  }
}

function selectNonDuplicateCandidate(observations, state, options) {
  const openPools = new Set(state.open_positions.map((position) => position.pool));
  const filtered = observations.filter((entry) => !openPools.has(entry.pool?.pool));
  return selectPaperCandidate(filtered, options);
}

async function refreshOpenPositions({ timeframe, autoExit, exitRules, label = "monitor" }) {
  const stateBefore = loadPaperState();
  if (!stateBefore.open_positions.length) {
    writeRuntime({ mode: label, open_positions: 0, last_monitor_at: new Date().toISOString() });
    return stateBefore;
  }

  const state = await refreshPaperState({ timeframe, autoClose: autoExit, exitRules });
  const autoClosedCount = state.last_auto_closed?.length || 0;
  writeRuntime({
    mode: label,
    open_positions: state.open_positions.length,
    auto_closed_last_monitor: autoClosedCount,
    last_monitor_at: new Date().toISOString(),
  });
  console.log(`[${label}] refreshed ${stateBefore.open_positions.length} open paper position(s)${autoClosedCount ? `, auto-closed ${autoClosedCount}` : ""}`);
  for (const position of state.open_positions) {
    const check = position.last_check;
    if (!check) continue;
    console.log(`[${label}] ${position.pool_name}: held=${check.held_minutes}m vol/activeTVL=${check.volume_active_tvl_ratio}x fee/TVL=${check.fee_active_tvl_ratio}% price=${check.price_change_from_entry_pct}% est_pnl=${check.estimated_paper_pnl_pct}% friction=${check.execution_cost_pct ?? 0}% signals=${check.exit_signals?.length || 0}`);
  }
  if (autoClosedCount) {
    printStateCompact(state, { showAutoClosed: true });
  }
  return state;
}

async function paperCycle({
  balance,
  entry,
  limit,
  maxOpen,
  forceBest,
  reset,
  timeframe,
  autoExit,
  exitRules,
  source,
} = {}) {
  if (reset) {
    const state = resetPaperState(balance);
    console.log(`Reset virtual paper account to ${formatSol(state.balance_sol)}`);
  }

  let state = loadPaperState({ initialBalanceSol: balance });
  let autoClosedThisCycle = false;

  if (state.open_positions.length > 0) {
    console.log("Refreshing open paper positions...");
    state = await refreshPaperState({ timeframe, autoClose: autoExit, exitRules });
    if (state.last_auto_closed?.length) {
      autoClosedThisCycle = true;
      console.log(`Auto-closed ${state.last_auto_closed.length} paper position(s).`);
    }
  }

  writeRuntime({ mode: "scan", last_scan_started_at: new Date().toISOString(), source });
  console.log(`Scanning candidates... source=${source}`);
  const { observations, summary, source: actualSource, scan_summary } = await scanPaperCandidates({ limit, source });
  writeRuntime({
    mode: "scan_done",
    source: actualSource,
    last_scan_finished_at: new Date().toISOString(),
    last_scan_summary: summary,
    scan_summary,
  });
  console.log(`Decision summary: ${JSON.stringify(summary)} | source=${actualSource}`);

  const best = observations[0];
  if (best) console.log(`Best observed: ${formatDeterministicCandidateLine(best, 0)}`);

  state = loadPaperState({ initialBalanceSol: balance });
  if (state.open_positions.length >= maxOpen) {
    console.log(`Max paper positions reached (${state.open_positions.length}/${maxOpen}); no new entry.`);
    printStateCompact(state, { showAutoClosed: autoClosedThisCycle });
    return;
  }

  if (state.balance_sol < entry) {
    console.log(`Insufficient virtual SOL for new entry: ${formatSol(state.balance_sol)} < ${formatSol(entry)}.`);
    printStateCompact(state, { showAutoClosed: autoClosedThisCycle });
    return;
  }

  const selected = selectNonDuplicateCandidate(observations, state, { forceBest });
  if (!selected.entry) {
    console.log("No eligible candidate. Nothing opened. Add --force-best to intentionally paper-test the best rejected pool.");
    printStateCompact(state, { showAutoClosed: autoClosedThisCycle });
    return;
  }

  const { position, state: openedState } = openPaperPosition({
    pool: selected.entry.pool,
    deterministic: selected.entry.deterministic,
    amountSol: entry,
    initialBalanceSol: balance,
    forced: selected.forced,
    note: selected.forced ? "paper-agent force-best" : "paper-agent eligible entry",
  });

  writeRuntime({ mode: "opened", last_opened_position: position.id, last_opened_pool: position.pool_name });
  console.log(`${selected.forced ? "FORCED PAPER ENTRY" : "PAPER ENTRY"}: ${position.pool_name} | ${formatSol(position.amount_sol)} | score=${position.entry_score} | decision=${position.entry_decision}`);
  console.log(`Position id: ${position.id}`);
  printStateCompact(openedState, { showAutoClosed: autoClosedThisCycle });
}

async function sleepWithMonitoring({ intervalSec, monitorIntervalSec, timeframe, autoExit, exitRules }) {
  let remaining = intervalSec;
  while (remaining > 0) {
    const wait = Math.min(remaining, monitorIntervalSec);
    const nextType = remaining <= monitorIntervalSec ? "scan" : "position monitor";
    writeRuntime({ mode: "sleep", next_action: nextType, next_action_in_sec: wait, scan_remaining_sec: remaining });
    console.log(`Sleeping ${wait}s before next ${nextType}. Press Ctrl+C to stop.`);
    await sleep(wait * 1000);
    remaining -= wait;
    if (remaining > 0) {
      await refreshOpenPositions({ timeframe, autoExit, exitRules, label: "monitor" });
    }
  }
}

async function main() {
  const balance = Number(argValue("balance", "0.1"));
  const entry = Number(argValue("entry", "0.01"));
  const limit = Number(argValue("limit", "10"));
  const maxOpen = Number(argValue("max-open", "3"));
  const intervalSec = Number(argValue("interval", "300"));
  const monitorIntervalSec = Number(argValue("monitor-interval", "30"));
  const timeframe = argValue("timeframe", "5m");
  const source = argValue("source", "auto");
  const reset = hasFlag("reset");
  const loop = hasFlag("loop");
  const forceBest = hasFlag("force-best");
  const autoExit = !hasFlag("no-auto-exit");
  const exitRules = buildExitRules({ forceBest });

  writeRuntime({
    mode: "starting",
    source,
    balance,
    entry,
    limit,
    maxOpen,
    intervalSec,
    monitorIntervalSec,
    timeframe,
    forceBest,
    autoExit,
    exitRules,
  });

  console.log("=== Streamlined Paper Agent ===");
  console.log(`balance=${balance} SOL entry=${entry} SOL max_open=${maxOpen} limit=${limit} timeframe=${timeframe} source=${source} force_best=${forceBest} loop=${loop} auto_exit=${autoExit}`);
  console.log(`scan_interval=${intervalSec}s monitor_interval=${monitorIntervalSec}s`);
  console.log(`exit_rules=${JSON.stringify(exitRules)}\n`);

  if (!loop) {
    await paperCycle({ balance, entry, limit, maxOpen, forceBest, reset, timeframe, autoExit, exitRules, source });
    return;
  }

  let first = true;
  while (true) {
    console.log(`\n--- Paper cycle ${new Date().toISOString()} ---`);
    await paperCycle({
      balance,
      entry,
      limit,
      maxOpen,
      forceBest,
      reset: first && reset,
      timeframe,
      autoExit,
      exitRules,
      source,
    });
    first = false;
    await sleepWithMonitoring({ intervalSec, monitorIntervalSec, timeframe, autoExit, exitRules });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
