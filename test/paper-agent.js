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

function buildExitRules() {
  return {
    ...DEFAULT_PAPER_EXIT_RULES,
    minHoldBeforeWeakExitMinutes: Number(argValue("weak-exit-min", DEFAULT_PAPER_EXIT_RULES.minHoldBeforeWeakExitMinutes)),
    forcedMaxHoldMinutes: Number(argValue("forced-max-hold", DEFAULT_PAPER_EXIT_RULES.forcedMaxHoldMinutes)),
    maxHoldMinutes: Number(argValue("max-hold", DEFAULT_PAPER_EXIT_RULES.maxHoldMinutes)),
    minVolumeActiveTvlRatio: Number(argValue("min-vol-ratio", DEFAULT_PAPER_EXIT_RULES.minVolumeActiveTvlRatio)),
    minFeeActiveTvlRatio: Number(argValue("min-fee-tvl", DEFAULT_PAPER_EXIT_RULES.minFeeActiveTvlRatio)),
    stopLossPct: Number(argValue("stop-loss", DEFAULT_PAPER_EXIT_RULES.stopLossPct)),
    takeProfitFeeProxyPct: Number(argValue("take-profit", DEFAULT_PAPER_EXIT_RULES.takeProfitFeeProxyPct)),
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
      console.log(`  held=${check.held_minutes}m | vol/activeTVL=${check.volume_active_tvl_ratio}x | fee/TVL=${check.fee_active_tvl_ratio}% | price_change=${check.price_change_from_entry_pct}% | fee_proxy=${check.fee_proxy_sol} SOL`);
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
  if (!stateBefore.open_positions.length) return stateBefore;

  const state = await refreshPaperState({ timeframe, autoClose: autoExit, exitRules });
  const autoClosedCount = state.last_auto_closed?.length || 0;
  console.log(`[${label}] refreshed ${stateBefore.open_positions.length} open paper position(s)${autoClosedCount ? `, auto-closed ${autoClosedCount}` : ""}`);
  for (const position of state.open_positions) {
    const check = position.last_check;
    if (!check) continue;
    console.log(`[${label}] ${position.pool_name}: held=${check.held_minutes}m vol/activeTVL=${check.volume_active_tvl_ratio}x fee/TVL=${check.fee_active_tvl_ratio}% price=${check.price_change_from_entry_pct}% signals=${check.exit_signals?.length || 0}`);
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

  console.log("Scanning candidates...");
  const { observations, summary } = await scanPaperCandidates({ limit });
  console.log(`Decision summary: ${JSON.stringify(summary)}`);

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

  console.log(`${selected.forced ? "FORCED PAPER ENTRY" : "PAPER ENTRY"}: ${position.pool_name} | ${formatSol(position.amount_sol)} | score=${position.entry_score} | decision=${position.entry_decision}`);
  console.log(`Position id: ${position.id}`);
  printStateCompact(openedState, { showAutoClosed: autoClosedThisCycle });
}

async function sleepWithMonitoring({ intervalSec, monitorIntervalSec, timeframe, autoExit, exitRules }) {
  let remaining = intervalSec;
  while (remaining > 0) {
    const wait = Math.min(remaining, monitorIntervalSec);
    console.log(`Sleeping ${wait}s before next ${remaining <= monitorIntervalSec ? "scan" : "position monitor"}. Press Ctrl+C to stop.`);
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
  const reset = hasFlag("reset");
  const loop = hasFlag("loop");
  const forceBest = hasFlag("force-best");
  const autoExit = !hasFlag("no-auto-exit");
  const exitRules = buildExitRules();

  console.log("=== Streamlined Paper Agent ===");
  console.log(`balance=${balance} SOL entry=${entry} SOL max_open=${maxOpen} limit=${limit} timeframe=${timeframe} force_best=${forceBest} loop=${loop} auto_exit=${autoExit}`);
  console.log(`scan_interval=${intervalSec}s monitor_interval=${monitorIntervalSec}s`);
  console.log(`exit_rules=${JSON.stringify(exitRules)}\n`);

  if (!loop) {
    await paperCycle({ balance, entry, limit, maxOpen, forceBest, reset, timeframe, autoExit, exitRules });
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
    });
    first = false;
    await sleepWithMonitoring({ intervalSec, monitorIntervalSec, timeframe, autoExit, exitRules });
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
