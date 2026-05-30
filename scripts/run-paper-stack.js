import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const ROOT_DIR = process.cwd();
const DASHBOARD_DIR = path.join(ROOT_DIR, "dashboard");
const VITE_BIN = path.join(DASHBOARD_DIR, "node_modules", "vite", "bin", "vite.js");

const config = {
  balance: argValue("balance", "0.1"),
  entry: argValue("entry", "0.01"),
  limit: argValue("limit", "10"),
  maxOpen: argValue("max-open", "3"),
  interval: argValue("interval", "300"),
  monitorInterval: argValue("monitor-interval", "30"),
  timeframe: argValue("timeframe", "5m"),
  source: argValue("source", "auto"),
  forceBest: hasFlag("force-best"),
  reset: hasFlag("reset"),
  noAutoExit: hasFlag("no-auto-exit"),
  stopLoss: argValue("stop-loss", null),
  takeProfit: argValue("take-profit", null),
  maxHold: argValue("max-hold", null),
  apiHost: argValue("api-host", "127.0.0.1"),
  apiPort: argValue("api-port", "8787"),
};

const children = [];
let shuttingDown = false;

function nodeCommand() {
  return process.execPath;
}

function startProcess(name, command, args, options = {}) {
  const cwd = options.cwd || ROOT_DIR;
  console.log(`[stack] starting ${name}: ${command} ${args.join(" ")}`);
  const child = spawn(command, args, {
    cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...options.env,
    },
  });

  children.push({ name, child });

  child.stdout.on("data", (data) => {
    for (const line of String(data).split(/\r?\n/).filter(Boolean)) {
      console.log(`[${name}] ${line}`);
    }
  });

  child.stderr.on("data", (data) => {
    for (const line of String(data).split(/\r?\n/).filter(Boolean)) {
      console.error(`[${name}] ${line}`);
    }
  });

  child.on("error", (error) => {
    console.error(`[stack] ${name} failed to start: ${error.message}`);
    shutdown(1);
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.log(`[stack] ${name} exited with code=${code} signal=${signal}`);
    if (name === "dashboard" || name === "api") {
      console.log("[stack] critical process exited, shutting down stack...");
      shutdown(code || 1);
    }
  });

  return child;
}

function buildPaperArgs() {
  const args = [
    "test/paper-agent.js",
    "--loop",
    `--balance=${config.balance}`,
    `--entry=${config.entry}`,
    `--limit=${config.limit}`,
    `--max-open=${config.maxOpen}`,
    `--interval=${config.interval}`,
    `--monitor-interval=${config.monitorInterval}`,
    `--timeframe=${config.timeframe}`,
    `--source=${config.source}`,
  ];

  if (config.forceBest) args.push("--force-best");
  if (config.reset) args.push("--reset");
  if (config.noAutoExit) args.push("--no-auto-exit");
  if (config.stopLoss != null) args.push(`--stop-loss=${config.stopLoss}`);
  if (config.takeProfit != null) args.push(`--take-profit=${config.takeProfit}`);
  if (config.maxHold != null) args.push(`--max-hold=${config.maxHold}`);

  return args;
}

function buildDashboardArgs() {
  if (!fs.existsSync(VITE_BIN)) {
    throw new Error(`Vite not found at ${VITE_BIN}. Run npm install --workspace dashboard from the repo root.`);
  }
  return [VITE_BIN, "--host", "127.0.0.1", "--port", "5173"];
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[stack] stopping paper stack...");

  for (const { name, child } of children) {
    if (!child.killed) {
      console.log(`[stack] stopping ${name}`);
      child.kill("SIGINT");
    }
  }

  setTimeout(() => {
    for (const { child } of children) {
      if (!child.killed) child.kill("SIGTERM");
    }
    process.exit(code);
  }, 1500).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("=== Meridian Paper Stack ===");
console.log("Starts: paper agent loop + read-only API + Solid dashboard");
console.log("Dashboard: http://127.0.0.1:5173");
console.log(`API:       http://${config.apiHost}:${config.apiPort}`);
console.log(`Paper:     balance=${config.balance} SOL entry=${config.entry} SOL scan=${config.interval}s monitor=${config.monitorInterval}s source=${config.source} forceBest=${config.forceBest}`);
console.log("Press Ctrl+C to stop everything.\n");

try {
  startProcess("paper", nodeCommand(), buildPaperArgs());
  startProcess("api", nodeCommand(), ["scripts/paper-dashboard-api.js", `--host=${config.apiHost}`, `--port=${config.apiPort}`]);
  startProcess("dashboard", nodeCommand(), buildDashboardArgs(), { cwd: DASHBOARD_DIR });
} catch (error) {
  console.error(`[stack] ${error.message}`);
  shutdown(1);
}
