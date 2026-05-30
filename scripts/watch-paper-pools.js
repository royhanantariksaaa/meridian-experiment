import "../envcrypt.js";
import fs from "fs";
import path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../config.js";
import { loadPaperState } from "../tools/paper-simulator.js";

const OUT_DIR = path.join(process.cwd(), "logs", "paper-sim");
const EVENT_FILE = path.join(OUT_DIR, "ws-events.jsonl");
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
  const refreshSec = Number(argValue("refresh", "10"));
  const commitment = argValue("commitment", "processed");
  const includeLogs = !hasFlag("no-logs");
  const includeAccount = !hasFlag("no-account");

  if (!wsEndpoint) throw new Error("Could not derive WebSocket endpoint. Pass --ws=wss://... or set WS_RPC_URL.");

  const connection = new Connection(rpcUrl, { commitment, wsEndpoint });
  const subscriptions = new Map(); // pool -> { accountSubId, logsSubId, meta }

  async function unsubscribePool(pool) {
    const sub = subscriptions.get(pool);
    if (!sub) return;
    if (sub.accountSubId != null) {
      await connection.removeAccountChangeListener(sub.accountSubId).catch(() => {});
    }
    if (sub.logsSubId != null) {
      await connection.removeOnLogsListener(sub.logsSubId).catch(() => {});
    }
    subscriptions.delete(pool);
    appendEvent({ type: "unsubscribe", pool, pool_name: sub.meta?.pool_name });
    console.log(`[ws] unsubscribed ${sub.meta?.pool_name || pool} (${shortId(pool)})`);
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

    const sub = { accountSubId: null, logsSubId: null, meta };

    if (includeAccount) {
      sub.accountSubId = connection.onAccountChange(pubkey, (accountInfo, context) => {
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
        console.log(`[ws] account ${meta.pool_name || shortId(meta.pool)} slot=${context.slot} data_len=${payload.data_len}`);
      }, commitment);
    }

    if (includeLogs) {
      sub.logsSubId = connection.onLogs(pubkey, (logs, context) => {
        const payload = {
          type: "logs",
          pool: meta.pool,
          pool_name: meta.pool_name,
          position_id: meta.id,
          slot: context.slot,
          signature: logs.signature,
          err: logs.err ?? null,
          log_count: Array.isArray(logs.logs) ? logs.logs.length : 0,
          logs: Array.isArray(logs.logs) ? logs.logs.slice(0, 12) : [],
          source_timeframe: meta.source_timeframe,
          entry_score: meta.entry_score,
          entry_decision: meta.entry_decision,
          forced: meta.forced,
        };
        appendEvent(payload);
        console.log(`[ws] logs ${meta.pool_name || shortId(meta.pool)} slot=${context.slot} sig=${logs.signature}`);
      }, commitment);
    }

    subscriptions.set(meta.pool, sub);
    appendEvent({ type: "subscribe", pool: meta.pool, pool_name: meta.pool_name, position_id: meta.id, includeAccount, includeLogs });
    console.log(`[ws] subscribed ${meta.pool_name || meta.pool} (${shortId(meta.pool)}) account=${includeAccount} logs=${includeLogs}`);
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
    console.log(`[ws] heartbeat open=${open.length} subs=${subscriptions.size} events=${EVENT_FILE}`);
  }

  console.log("=== Paper Pool WebSocket Watcher ===");
  console.log(`rpc=${rpcUrl}`);
  console.log(`ws=${wsEndpoint}`);
  console.log(`commitment=${commitment} refresh=${refreshSec}s account=${includeAccount} logs=${includeLogs}`);
  console.log(`events=${EVENT_FILE}`);
  appendEvent({ type: "start", rpcUrl, wsEndpoint, commitment, refreshSec, includeAccount, includeLogs });

  let shuttingDown = false;
  process.on("SIGINT", async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n[ws] shutting down...");
    for (const pool of [...subscriptions.keys()]) await unsubscribePool(pool);
    appendEvent({ type: "stop" });
    process.exit(0);
  });

  while (!shuttingDown) {
    await reconcile().catch((error) => {
      appendEvent({ type: "reconcile_error", error: error.message });
      console.error(`[ws] reconcile error: ${error.message}`);
    });
    await sleep(Math.max(1, refreshSec) * 1000);
  }
}

main().catch((error) => {
  console.error(error);
  appendEvent({ type: "fatal", error: error.message });
  process.exitCode = 1;
});
