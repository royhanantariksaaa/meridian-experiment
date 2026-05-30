import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const LOG_DIR = path.join(ROOT_DIR, "logs");

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const HOST = argValue("host", "127.0.0.1");
const PORT = Number(argValue("port", "8787"));

function sendJson(res, payload, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(payload, null, 2));
}

function safeReadJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return { error: error.message, file };
  }
}

function fileMtime(file) {
  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
}

function getFilesByMtime(dir, predicate = () => true) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .map((name) => path.join(dir, name))
      .filter((file) => {
        try {
          return fs.statSync(file).isFile() && predicate(file);
        } catch {
          return false;
        }
      })
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch {
    return [];
  }
}

function readLatestJsonl(dir, predicate = (file) => file.endsWith(".jsonl")) {
  const files = getFilesByMtime(dir, predicate);
  for (const file of files) {
    try {
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          return {
            file,
            filename: path.basename(file),
            mtime: fileMtime(file),
            payload: JSON.parse(lines[i]),
          };
        } catch {
          // Keep searching older lines.
        }
      }
    } catch {
      // Try next file.
    }
  }
  return null;
}

function getPaperState() {
  const file = path.join(LOG_DIR, "paper-sim", "state.json");
  return safeReadJson(file, {
    version: 1,
    missing: true,
    starting_balance_sol: null,
    balance_sol: null,
    open_positions: [],
    closed_positions: [],
    events: [],
    last_updated: null,
  });
}

function getSummary() {
  const state = getPaperState();
  const openPositions = Array.isArray(state?.open_positions) ? state.open_positions : [];
  const closedPositions = Array.isArray(state?.closed_positions) ? state.closed_positions : [];
  const events = Array.isArray(state?.events) ? state.events : [];
  const realizedPnlSol = closedPositions.reduce((sum, p) => sum + Number(p?.realized_pnl_sol || 0), 0);
  const wins = closedPositions.filter((p) => Number(p?.realized_pnl_sol || 0) > 0).length;
  const losses = closedPositions.filter((p) => Number(p?.realized_pnl_sol || 0) < 0).length;

  return {
    server: {
      now: new Date().toISOString(),
      root_dir: ROOT_DIR,
      log_dir: LOG_DIR,
      read_only: true,
    },
    paper: {
      state,
      summary: {
        starting_balance_sol: state?.starting_balance_sol ?? null,
        balance_sol: state?.balance_sol ?? null,
        open_count: openPositions.length,
        closed_count: closedPositions.length,
        realized_pnl_sol: Number(realizedPnlSol.toFixed(9)),
        wins,
        losses,
        win_rate: closedPositions.length ? Number(((wins / closedPositions.length) * 100).toFixed(2)) : null,
        last_updated: state?.last_updated ?? null,
        recent_events: events.slice(-20).reverse(),
      },
    },
    screening: {
      observer: readLatestJsonl(path.join(LOG_DIR, "screening-observer")),
      snapshots: readLatestJsonl(path.join(LOG_DIR, "screening-snapshots")),
    },
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    res.end();
    return;
  }

  if (url.pathname === "/health") {
    sendJson(res, { ok: true, now: new Date().toISOString(), read_only: true });
    return;
  }

  if (url.pathname === "/api/summary") {
    sendJson(res, getSummary());
    return;
  }

  if (url.pathname === "/api/paper-state") {
    sendJson(res, getPaperState());
    return;
  }

  sendJson(res, { error: "not found" }, 404);
});

server.listen(PORT, HOST, () => {
  console.log(`Paper dashboard API listening on http://${HOST}:${PORT}`);
  console.log("Read-only mode. No trading actions are exposed.");
});
