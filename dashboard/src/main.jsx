import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { render } from "solid-js/web";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Clock,
  PauseCircle,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-solid";
import "./index.css";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Progress, Separator } from "./components/ui";
import { cn, formatPct, formatRatio, formatSol, shortId, timeAgo } from "./lib/utils";

const API_BASE = import.meta.env.VITE_DASHBOARD_API || "http://127.0.0.1:8787";
const REFRESH_MS = 5000;

function StatCard(props) {
  return (
    <Card class="overflow-hidden">
      <CardHeader class="pb-3">
        <div class="flex items-center justify-between">
          <CardDescription>{props.label}</CardDescription>
          <div class="rounded-xl bg-primary/10 p-2 text-primary">{props.icon}</div>
        </div>
        <CardTitle class="text-2xl">{props.value}</CardTitle>
      </CardHeader>
      <CardContent>
        <p class={cn("text-xs", props.tone === "bad" ? "text-red-300" : props.tone === "good" ? "text-emerald-300" : "text-muted-foreground")}>{props.hint}</p>
      </CardContent>
    </Card>
  );
}

function PositionCard(props) {
  const p = () => props.position;
  const check = () => p()?.last_check || {};
  const danger = createMemo(() => (check().exit_signals || []).length > 0);
  const pnl = createMemo(() => Number(p()?.realized_pnl_sol ?? 0));

  return (
    <Card class={cn("transition", danger() && "border-yellow-500/30")}> 
      <CardHeader>
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle class="flex items-center gap-2">
              {p()?.pool_name || "Unknown pool"}
              <Badge variant={p()?.status === "CLOSED" ? "secondary" : danger() ? "yellow" : "green"}>{p()?.status || "OPEN"}</Badge>
              <Show when={p()?.forced}><Badge variant="red">forced</Badge></Show>
            </CardTitle>
            <CardDescription>
              pool {shortId(p()?.pool)} · mint {shortId(p()?.base?.mint)} · id {shortId(p()?.id)}
            </CardDescription>
          </div>
          <div class="text-right">
            <div class="text-lg font-semibold">{formatSol(p()?.amount_sol)}</div>
            <div class="text-xs text-muted-foreground">score {p()?.entry_score ?? "—"} · {p()?.entry_decision || "—"}</div>
          </div>
        </div>
      </CardHeader>
      <CardContent class="space-y-4">
        <div class="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <div class="rounded-xl bg-secondary/50 p-3">
            <div class="text-muted-foreground">Entry vol/aTVL</div>
            <div class="font-semibold">{formatRatio(p()?.entry_volume_active_tvl_ratio)}</div>
          </div>
          <div class="rounded-xl bg-secondary/50 p-3">
            <div class="text-muted-foreground">Entry fee/aTVL</div>
            <div class="font-semibold">{formatPct(p()?.entry_fee_active_tvl_ratio)}</div>
          </div>
          <div class="rounded-xl bg-secondary/50 p-3">
            <div class="text-muted-foreground">Bins below</div>
            <div class="font-semibold">{p()?.bins_below ?? "—"}</div>
          </div>
          <div class="rounded-xl bg-secondary/50 p-3">
            <div class="text-muted-foreground">Opened</div>
            <div class="font-semibold">{timeAgo(p()?.opened_at)}</div>
          </div>
        </div>

        <Show when={p()?.status === "CLOSED"}>
          <div class={cn("rounded-xl border p-3", pnl() >= 0 ? "border-emerald-500/30 bg-emerald-500/10" : "border-red-500/30 bg-red-500/10")}>
            <div class="flex items-center justify-between gap-4">
              <div>
                <div class="text-sm font-medium">Closed: {p()?.close_reason}</div>
                <div class="text-xs text-muted-foreground">{timeAgo(p()?.closed_at)}</div>
              </div>
              <div class={cn("font-semibold", pnl() >= 0 ? "text-emerald-300" : "text-red-300")}>{formatSol(p()?.realized_pnl_sol, 6)}</div>
            </div>
          </div>
        </Show>

        <Show when={p()?.last_check}>
          <div class="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div>
              <div class="text-muted-foreground">Held</div>
              <div class="font-semibold">{check().held_minutes ?? 0}m</div>
            </div>
            <div>
              <div class="text-muted-foreground">Now vol/aTVL</div>
              <div class="font-semibold">{formatRatio(check().volume_active_tvl_ratio)}</div>
            </div>
            <div>
              <div class="text-muted-foreground">Now fee/aTVL</div>
              <div class="font-semibold">{formatPct(check().fee_active_tvl_ratio)}</div>
            </div>
            <div>
              <div class="text-muted-foreground">Price change</div>
              <div class={cn("font-semibold", Number(check().price_change_from_entry_pct) < 0 ? "text-red-300" : "text-emerald-300")}>{formatPct(check().price_change_from_entry_pct)}</div>
            </div>
          </div>
          <Show when={(check().exit_signals || []).length > 0}>
            <div class="space-y-2">
              <div class="text-sm font-medium text-yellow-300">Exit signals</div>
              <div class="flex flex-wrap gap-2">
                <For each={check().exit_signals}>{(signal) => <Badge variant="yellow">{signal}</Badge>}</For>
              </div>
            </div>
          </Show>
        </Show>
      </CardContent>
    </Card>
  );
}

function CandidateRow(props) {
  const c = () => props.item;
  const d = () => c()?.deterministic || {};
  const decisionVariant = createMemo(() => {
    if (d().decision === "AUTO_DEPLOY_CANDIDATE") return "green";
    if (d().decision === "ASK_LLM") return "blue";
    return "secondary";
  });
  return (
    <div class="grid gap-3 rounded-xl border border-border bg-secondary/30 p-3 md:grid-cols-[1.4fr_.8fr_.8fr_.8fr] md:items-center">
      <div>
        <div class="font-medium">{c()?.name || c()?.pool_name || "Unknown"}</div>
        <div class="text-xs text-muted-foreground">pool {shortId(c()?.pool)} · mint {shortId(c()?.base?.mint)}</div>
      </div>
      <div>
        <Badge variant={decisionVariant()}>{d().decision || "—"}</Badge>
        <div class="mt-1 text-xs text-muted-foreground">score {d().score ?? "—"}</div>
      </div>
      <div class="text-sm">
        <div>fee/aTVL {formatPct(d()?.metrics?.fee_active_tvl_ratio)}</div>
        <div class="text-muted-foreground">vol/aTVL {formatRatio(d()?.metrics?.volume_active_tvl_ratio)}</div>
      </div>
      <div class="text-xs text-muted-foreground">{d().reason || "—"}</div>
    </div>
  );
}

function EventRow(props) {
  const e = () => props.event;
  const variant = createMemo(() => {
    if (String(e()?.type).includes("CLOSE")) return "red";
    if (e()?.type === "OPEN") return "green";
    if (e()?.type === "REFRESH") return "blue";
    return "secondary";
  });
  return (
    <div class="flex items-start justify-between gap-4 border-b border-border py-3 last:border-0">
      <div>
        <div class="flex items-center gap-2">
          <Badge variant={variant()}>{e()?.type || "EVENT"}</Badge>
          <span class="text-sm font-medium">{e()?.pool_name || e()?.reason || e()?.id || "Paper event"}</span>
        </div>
        <div class="mt-1 text-xs text-muted-foreground">{timeAgo(e()?.ts)} · {e()?.ts}</div>
      </div>
      <Show when={e()?.realized_pnl_sol != null}>
        <div class={cn("text-sm font-semibold", Number(e()?.realized_pnl_sol) >= 0 ? "text-emerald-300" : "text-red-300")}>{formatSol(e()?.realized_pnl_sol, 6)}</div>
      </Show>
    </div>
  );
}

function App() {
  const [data, setData] = createSignal(null);
  const [error, setError] = createSignal(null);
  const [loading, setLoading] = createSignal(true);

  async function load() {
    try {
      const res = await fetch(`${API_BASE}/api/summary`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setError(null);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  createEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  });

  const state = createMemo(() => data()?.paper?.state || {});
  const summary = createMemo(() => data()?.paper?.summary || {});
  const openPositions = createMemo(() => state()?.open_positions || []);
  const closedPositions = createMemo(() => (state()?.closed_positions || []).slice().reverse());
  const latestObserver = createMemo(() => data()?.screening?.observer?.payload || null);
  const latestCandidates = createMemo(() => latestObserver()?.observations || latestObserver()?.ranked || []);
  const balanceProgress = createMemo(() => {
    const start = Number(summary()?.starting_balance_sol || 0);
    const bal = Number(summary()?.balance_sol || 0);
    if (!start) return 0;
    return Math.max(0, Math.min(140, (bal / start) * 100));
  });

  return (
    <main class="mx-auto min-h-screen max-w-7xl px-4 py-6 md:px-8 md:py-10">
      <div class="mb-8 flex flex-col justify-between gap-4 md:flex-row md:items-end">
        <div>
          <div class="mb-2 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs text-primary">
            <ShieldCheck size={14} /> Read-only paper mode
          </div>
          <h1 class="text-3xl font-bold tracking-tight md:text-5xl">Meridian Paper Dashboard</h1>
          <p class="mt-2 max-w-2xl text-muted-foreground">Monitor virtual DLMM paper positions, auto-exit signals, candidate scoring, and paper PnL without exposing any trading action.</p>
        </div>
        <div class="flex gap-2">
          <Button onClick={load} disabled={loading()}><RefreshCcw size={16} /> Refresh</Button>
        </div>
      </div>

      <Show when={error()}>
        <Card class="mb-6 border-red-500/40 bg-red-500/10">
          <CardContent class="pt-5">
            <div class="flex items-center gap-2 text-red-200"><AlertTriangle size={18} /> API unavailable: {error()}</div>
            <p class="mt-2 text-sm text-muted-foreground">Run: <code>node scripts/paper-dashboard-api.js</code></p>
          </CardContent>
        </Card>
      </Show>

      <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Virtual Balance" value={formatSol(summary()?.balance_sol)} hint={`Started at ${formatSol(summary()?.starting_balance_sol)}`} icon={<Wallet size={18} />} tone="good" />
        <StatCard label="Realized Paper PnL" value={formatSol(summary()?.realized_pnl_sol, 6)} hint={`${summary()?.wins || 0} wins · ${summary()?.losses || 0} losses`} icon={Number(summary()?.realized_pnl_sol) >= 0 ? <TrendingUp size={18} /> : <TrendingDown size={18} />} tone={Number(summary()?.realized_pnl_sol) >= 0 ? "good" : "bad"} />
        <StatCard label="Open Positions" value={summary()?.open_count ?? 0} hint={`${summary()?.closed_count || 0} closed paper positions`} icon={<Activity size={18} />} />
        <StatCard label="Last Update" value={timeAgo(summary()?.last_updated)} hint={summary()?.last_updated || "No paper state yet"} icon={<Clock size={18} />} />
      </div>

      <Card class="mt-4">
        <CardHeader>
          <CardTitle>Balance Progress</CardTitle>
          <CardDescription>Virtual balance versus starting paper balance.</CardDescription>
        </CardHeader>
        <CardContent>
          <Progress value={balanceProgress()} />
        </CardContent>
      </Card>

      <div class="mt-6 grid gap-6 xl:grid-cols-[1.4fr_.9fr]">
        <div class="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle class="flex items-center gap-2"><Sparkles size={18} /> Open Paper Positions</CardTitle>
              <CardDescription>Current virtual positions and auto-exit signals.</CardDescription>
            </CardHeader>
            <CardContent class="space-y-4">
              <Show when={openPositions().length > 0} fallback={<EmptyState text="No open paper positions yet. Run paper-agent to create one." />}>
                <For each={openPositions()}>{(p) => <PositionCard position={p} />}</For>
              </Show>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle class="flex items-center gap-2"><PauseCircle size={18} /> Closed Paper Positions</CardTitle>
              <CardDescription>Recently closed virtual positions and realized proxy PnL.</CardDescription>
            </CardHeader>
            <CardContent class="space-y-4">
              <Show when={closedPositions().length > 0} fallback={<EmptyState text="No closed positions yet." />}>
                <For each={closedPositions().slice(0, 10)}>{(p) => <PositionCard position={p} />}</For>
              </Show>
            </CardContent>
          </Card>
        </div>

        <div class="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle class="flex items-center gap-2"><BarChart3 size={18} /> Latest Candidate Scores</CardTitle>
              <CardDescription>Latest observer or snapshot scoring output.</CardDescription>
            </CardHeader>
            <CardContent class="space-y-3">
              <Show when={latestCandidates().length > 0} fallback={<EmptyState text="No screening snapshot found yet." />}>
                <For each={latestCandidates().slice(0, 8)}>{(item) => <CandidateRow item={item} />}</For>
              </Show>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent Events</CardTitle>
              <CardDescription>Latest paper-sim state changes.</CardDescription>
            </CardHeader>
            <CardContent>
              <Show when={(summary()?.recent_events || []).length > 0} fallback={<EmptyState text="No events yet." />}>
                <For each={summary()?.recent_events || []}>{(event) => <EventRow event={event} />}</For>
              </Show>
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}

function EmptyState(props) {
  return (
    <div class="rounded-2xl border border-dashed border-border bg-secondary/20 p-8 text-center text-sm text-muted-foreground">
      {props.text}
    </div>
  );
}

render(() => <App />, document.getElementById("root"));
