import {
  closePaperPosition,
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

function command() {
  return process.argv[2] || "help";
}

function printHelp() {
  console.log(`Paper Simulator Commands

Usage:
  node test/paper-sim.js reset --balance=0.1
  node test/paper-sim.js scan --limit=10
  node test/paper-sim.js open --entry=0.01 --limit=10
  node test/paper-sim.js open --entry=0.01 --limit=10 --force-best
  node test/paper-sim.js refresh --timeframe=5m
  node test/paper-sim.js status
  node test/paper-sim.js close --id=<position_id> --pnl-pct=1.5 --reason="manual test close"

Notes:
  - This is virtual paper mode only. It never sends transactions.
  - --force-best opens the highest-scored candidate even if it was AUTO_SKIP.
  - Without --force-best, open only selects ASK_LLM or AUTO_DEPLOY_CANDIDATE candidates.
`);
}

function printState(state) {
  console.log(`Virtual balance: ${state.balance_sol} SOL`);
  console.log(`Open positions: ${state.open_positions.length}`);
  console.log(`Closed positions: ${state.closed_positions.length}`);

  if (state.open_positions.length > 0) {
    console.log("\nOPEN POSITIONS");
    for (const position of state.open_positions) {
      console.log(`- ${position.id} | ${position.pool_name} | ${position.amount_sol} SOL | score=${position.entry_score} | decision=${position.entry_decision}`);
      console.log(`  entry volume/activeTVL=${position.entry_volume_active_tvl_ratio}x | entry fee/TVL=${position.entry_fee_active_tvl_ratio}% | bins_below=${position.bins_below}`);
      if (position.last_check) {
        const check = position.last_check;
        console.log(`  last_check ${check.checked_at} | ${check.timeframe} | held=${check.held_minutes}m | price_change=${check.price_change_from_entry_pct}% | vol/activeTVL=${check.volume_active_tvl_ratio}x | fee_proxy=${check.fee_proxy_sol} SOL`);
        console.log(`  exit_signals=${check.exit_signals?.length ? check.exit_signals.join("; ") : "none"}`);
      }
    }
  }

  if (state.closed_positions.length > 0) {
    console.log("\nCLOSED POSITIONS");
    for (const position of state.closed_positions.slice(-10)) {
      console.log(`- ${position.id} | ${position.pool_name} | pnl=${position.realized_pnl_sol} SOL | reason=${position.close_reason}`);
    }
  }
}

async function run() {
  const cmd = command();

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }

  if (cmd === "reset") {
    const balance = Number(argValue("balance", "0.1"));
    const state = resetPaperState(balance);
    console.log(`Reset paper sim to ${state.balance_sol} SOL`);
    return;
  }

  if (cmd === "scan") {
    const limit = Number(argValue("limit", "10"));
    const { observations, summary } = await scanPaperCandidates({ limit });
    console.log(`Decision summary: ${JSON.stringify(summary)}\n`);
    observations.forEach((entry, index) => {
      console.log(formatDeterministicCandidateLine(entry, index));
    });
    return;
  }

  if (cmd === "open") {
    const limit = Number(argValue("limit", "10"));
    const amountSol = Number(argValue("entry", "0.01"));
    const initialBalanceSol = Number(argValue("balance", "0.1"));
    const forceBest = hasFlag("force-best");
    const { observations, summary } = await scanPaperCandidates({ limit });
    console.log(`Decision summary: ${JSON.stringify(summary)}`);
    const selected = selectPaperCandidate(observations, { forceBest });
    if (!selected.entry) {
      console.log("No eligible paper entry. Use --force-best to intentionally test the highest-scored rejected candidate.");
      return;
    }
    const { position, state } = openPaperPosition({
      pool: selected.entry.pool,
      deterministic: selected.entry.deterministic,
      amountSol,
      initialBalanceSol,
      forced: selected.forced,
      note: selected.forced ? "force-best paper test" : "eligible paper test",
    });
    console.log(`${selected.forced ? "FORCED" : "OPENED"} paper position:`);
    console.log(`- id=${position.id}`);
    console.log(`- pool=${position.pool_name} (${position.pool})`);
    console.log(`- amount=${position.amount_sol} SOL`);
    console.log(`- score=${position.entry_score} decision=${position.entry_decision}`);
    console.log(`- virtual balance remaining=${state.balance_sol} SOL`);
    return;
  }

  if (cmd === "refresh") {
    const timeframe = argValue("timeframe", "5m");
    const state = await refreshPaperState({ timeframe });
    printState(state);
    return;
  }

  if (cmd === "status") {
    const state = loadPaperState();
    printState(state);
    return;
  }

  if (cmd === "close") {
    const id = argValue("id");
    if (!id) throw new Error("close requires --id=<position_id>");
    const pnlSol = argValue("pnl-sol", null);
    const pnlPct = argValue("pnl-pct", null);
    const reason = argValue("reason", "manual paper close");
    const { closed, state } = closePaperPosition({
      id,
      pnlSol: pnlSol == null ? null : Number(pnlSol),
      pnlPct: pnlPct == null ? null : Number(pnlPct),
      reason,
    });
    console.log(`Closed ${closed.id} | pnl=${closed.realized_pnl_sol} SOL | balance=${state.balance_sol} SOL`);
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
