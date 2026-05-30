import { cn } from "../lib/utils";

export function Card(props) {
  return <div class={cn("rounded-2xl border border-border bg-card/80 text-card-foreground shadow-glow backdrop-blur", props.class)}>{props.children}</div>;
}

export function CardHeader(props) {
  return <div class={cn("flex flex-col space-y-1.5 p-5", props.class)}>{props.children}</div>;
}

export function CardTitle(props) {
  return <h3 class={cn("text-base font-semibold leading-none tracking-tight", props.class)}>{props.children}</h3>;
}

export function CardDescription(props) {
  return <p class={cn("text-sm text-muted-foreground", props.class)}>{props.children}</p>;
}

export function CardContent(props) {
  return <div class={cn("p-5 pt-0", props.class)}>{props.children}</div>;
}

export function Badge(props) {
  const variant = props.variant || "default";
  return (
    <span class={cn(
      "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
      variant === "default" && "border-transparent bg-primary text-primary-foreground",
      variant === "secondary" && "border-transparent bg-secondary text-secondary-foreground",
      variant === "outline" && "border-border text-foreground",
      variant === "green" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
      variant === "yellow" && "border-yellow-500/30 bg-yellow-500/10 text-yellow-300",
      variant === "red" && "border-red-500/30 bg-red-500/10 text-red-300",
      variant === "blue" && "border-sky-500/30 bg-sky-500/10 text-sky-300",
      props.class,
    )}>{props.children}</span>
  );
}

export function Button(props) {
  return (
    <button
      {...props}
      class={cn(
        "inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground transition hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50",
        props.class,
      )}
    >
      {props.children}
    </button>
  );
}

export function Separator(props) {
  return <div class={cn("h-px w-full bg-border", props.class)} />;
}

export function Progress(props) {
  const value = Math.max(0, Math.min(100, Number(props.value || 0)));
  return (
    <div class={cn("relative h-2 w-full overflow-hidden rounded-full bg-secondary", props.class)}>
      <div class="h-full rounded-full bg-primary transition-all" style={{ width: `${value}%` }} />
    </div>
  );
}
