import "../envcrypt.js";
import fs from "fs";
import path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../config.js";
import { loadPaperState, refreshPaperState, DEFAULT_PAPER_EXIT_RULES } from "../tools/paper-simulator.js";

const OUT_DIR = path.join(process.cwd(), "logs", "paper-sim");
const EVENT_FILE = path.join(OUT_DIR, "ws-refresh-events.jsonl");
const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";

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

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function appendEvent(event) {
  ensureDir(OUT_DIR);
  fs.appendFileSync(EVENT_FILE, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
}

function numericArg(name, fallback) {
  const n = Number(argValue(name, fallback));
  return Number.isFinite(n) ? n : fallback;
}

function buildExitRules() {
  return {
    ...DEFAULT_PAPER_EXIT_RULES,
    minHoldBeforeWeakExitMinutes: numericArg("weak-exit-min", DEFAULT_PAPER_EXIT_RULES.minHoldBeforeWeakExitMinutes),
    forcedMaxHoldMinutes: numericArg("forced-max-hold", DEFAULT_PAPER_EXIT_RULES.forcedMaxHoldMinutes),
    maxHoldMinutes: numericArg("max-hold", DEFAULT_PAPER_EXIT_RULES.maxHoldMinutes),
    minVolumeActiveTvlRatio: numericArg("min-vol-ratio", DEFAULT_PAPER_EXIT_RULES.minVolumeActiveTvlRatio),
    minFeeActiveTvlRatio: numericArg("min-fee-tvl", DEFAULT_PAPER_EXIT_RULES.minFeeActiveTvlRatio),
    stopLossPct: numericArg("stop-loss", DEFAULT_PAPER_EXIT_RULES.stopLossPct),
    takeProfitFeeProxyPct: numericArg("take-profit", DEFAULT_PAPER_EXIT_RULES.takeProfitFeeProxyPct),
  };
}

function deriveWsEndpoint(rpcUrl) {
  const explicit = process.env.WS_RPC_URL || process.env.RPC_WS_URL || process.env.SOLANA_WS_URL || process.env.WEBSOCKET_RPC_URL;
  if (explicit) return explicit;
  if (rpcUrl.startsWith("https://")) return rpcUrl.replace(/^https:\/\//, "wss://");
  if (rpcUrl.startsWith("http://")) return rpcUrl.replace(/^http:\/\//, "ws://");
  return null;
}

function getRpcUrl() {
  return process.env.RPC_URL || config?.rpc?.url || DEFAULT_RPC_URL;
}

function getOpenPaperPools() {
  const state = loadPaperState();
  return (state.open_positions || [])
    .filter((position) => position?.pool)
    .map((position) => ({
      pool: position.pool,
      pool_name: position.pool_name,
      id: position.id,
      source_timeframe: position.source_timeframe,
      entry_score: position.entry_score,
      entry_decision: position.entry_decision,
      forced: position.forced,
    }));
}

function shortId(value) {
  return String(value || "").slice(0, 8);
}

async function main() {
  const rpcUrl = argValue("rpc", getRpcUrl());
  const wsEndpoint = argValue("ws", deriveWsEndpoint(rpcUrl));
  const refreshSec = numericArg("refresh", 10);
  const debounceMs = numericArg("debounce-ms", 3000);
  const commitment = argValue("commitment", "processed");
  const monitorTimeframe = argValue("timeframe", "5m");
  const autoClose = !hasFlag("no-auto-exit");
  const exitRules = buildExitRules();

  if (!wsEndpoint) throw new Error("Could not derive WebSocket endpoint. Pass --ws=wss://... or set WS_RPC_URL.");

  const connection = new Connection(rpcUrl, { commitment, wsEndpoint });
  const subscriptions = new Map(); // pool -> { accountSubId, meta }
  const lastRefreshByPool = new Map();
  const pendingByPool = new Map();
  let refreshInFlight = false;

  async function triggerRefresh(meta, reason) {
    const now = Date.now();
    const last = lastRefreshByPool.get(meta.pool) || 0;
    const elapsed = now - last;

    if (elapsed < debounceMs) {
      if (!pendingByPool.has(meta.pool)) {
        const wait = debounceMs - elapsed;
        const timer = setTimeout(() => {
          pendingByPool.delete(meta.pool);
          triggerRefresh(meta, "debounced_account_change").catch((error) => {
            appendEvent({ type: "refresh_error", pool: meta.pool, pool_name: meta.pool_name, error: error.message });
          });
        }, wait);
        pendingByPool.set(meta.pool, timer);
      }
      return;
    }

    if (refreshInFlight) {
      if (!pendingByPool.has(meta.pool)) {
        const timer = setTimeout(() => {
          pendingByPool.delete(meta.pool);
          triggerRefresh(meta, "queued_account_change").catch((error) => {
            appendEvent({ type: "refresh_error", pool: meta.pool, pool_name: meta.pool_name, error: error.message });
          });
        }, debounceMs);
        pendingByPool.set(meta.pool, timer);
      }
      return;
    }

    lastRefreshByPool.set(meta.pool, now);
    refreshInFlight = true;
    appendEvent({ type: "refresh_start", reason, pool: meta.pool, pool_name: meta.pool_name, position_id: meta.id, autoClose });
    console.log(`[ws-refresh] refresh start ${meta.pool_name || shortId(meta.pool)} reason=${reason}`);
    try {
      const state = await refreshPaperState({ timeframe: monitorTimeframe, autoClose, exitRules });
      const autoClosed = state.last_auto_closed?.length || 0;
      appendEvent({
        type: "refresh_done",
        reason,
        pool: meta.pool,
        pool_name: meta.pool_name,
        open_positions: state.open_positions.length,
        auto_closed: autoClosed,
        balance_sol: state.balance_sol,
      });
      console.log(`[ws-refresh] refresh done open=${state.open_positions.length} auto_closed=${autoClosed}`);
    } catch (error) {
      appendEvent({ type: "refresh_error", reason, pool: meta.pool, pool_name: meta.pool_name, error: error.message });
      console.error(`[ws-refresh] refresh error ${meta.pool_name || shortId(meta.pool)}: ${error.message}`);
    } finally {
      refreshInFlight = false;
    }
  }

  async function unsubscribePool(pool) {
    const sub = subscriptions.get(pool);
    if (!sub) return;
    if (sub.accountSubId != null) await connection.removeAccountChangeListener(sub.accountSubId).catch(() => {});
    subscriptions.delete(pool);
    appendEvent({ type: "unsubscribe", pool, pool_name: sub.meta?.pool_name });
    console.log(`[ws-refresh] unsubscribed ${sub.meta?.pool_name || pool} (${shortId(pool)})`);
  }

  async function subscribePool(meta) {
    if (subscriptions.has(meta.pool)) return;
    let pubkey;
    try {
      pubkey = new PublicKey(meta.pool);
    } catch (error) {
      appendEvent({ type: "bad_pool_pubkey", pool: meta.pool, pool_name: meta.pool_name, error: error.message });
      return;
    }

    const accountSubId = connection.onAccountChange(pubkey, (accountInfo, context) => {
      const payload = {
        type: "account_change",
        pool: meta.pool,
        pool_name: meta.pool_name,
        position_id: meta.id,
        slot: context.slot,
        lamports: accountInfo.lamports,
        data_len: accountInfo.data?.length ?? null,
        owner: accountInfo.owner?.toBase58?.() ?? null,
        source_timeframe: meta.source_timeframe,
        entry_score: meta.entry_score,
        entry_decision: meta.entry_decision,
        forced: meta.forced,
      };
      appendEvent(payload);
      console.log(`[ws-refresh] account ${meta.pool_name || shortId(meta.pool)} slot=${context.slot}`);
      triggerRefresh(meta, "account_change").catch((error) => {
        appendEvent({ type: "refresh_error", pool: meta.pool, pool_name: meta.pool_name, error: error.message });
      });
    }, commitment);

    subscriptions.set(meta.pool, { accountSubId, meta });
    appendEvent({ type: "subscribe", pool: meta.pool, pool_name: meta.pool_name, position_id: meta.id, debounceMs, autoClose });
    console.log(`[ws-refresh] subscribed ${meta.pool_name || meta.pool} (${shortId(meta.pool)}) debounce=${debounceMs}ms auto_close=${autoClose}`);
  }

  async function reconcile() {
    const open = getOpenPaperPools();
    const wanted = new Map(open.map((meta) => [meta.pool, meta]));

    for (const pool of [...subscriptions.keys()]) {
      if (!wanted.has(pool)) await unsubscribePool(pool);
    }
    for (const meta of wanted.values()) {
      await subscribePool(meta);
    }

    appendEvent({ type: "heartbeat", open_positions: open.length, subscriptions: subscriptions.size });
    console.log(`[ws-refresh] heartbeat open=${open.length} subs=${subscriptions.size} events=${EVENT_FILE}`);
  }

  console.log("=== Paper Pool WebSocket Refresh Watcher ===");
  console.log(`rpc=${rpcUrl}`);
  console.log(`ws=${wsEndpoint}`);
  console.log(`commitment=${commitment} reconcile=${refreshSec}s debounce=${debounceMs}ms auto_close=${autoClose}`);
  console.log(`events=${EVENT_FILE}`);
  appendEvent({ type: "start", rpcUrl, wsEndpoint, commitment, refreshSec, debounceMs, monitorTimeframe, autoClose, exitRules });

  let shuttingDown = false;
  process.on("SIGINT", async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n[ws-refresh] shutting down...");
    for (const timer of pendingByPool.values()) clearTimeout(timer);
    for (const pool of [...subscriptions.keys()]) await unsubscribePool(pool);
    appendEvent({ type: "stop" });
    process.exit(0);
  });

  while (!shuttingDown) {
    await reconcile().catch((error) => {
      appendEvent({ type: "reconcile_error", error: error.message });
      console.error(`[ws-refresh] reconcile error: ${error.message}`);
    });
    await sleep(Math.max(1, refreshSec) * 1000);
  }
}

main().catch((error) => {
  console.error(error);
  appendEvent({ type: "fatal", error: error.message });
  process.exitCode = 1;
});
