"use client";

import { useState } from "react";
import {
  ExternalLink,
  Loader2,
  Pause,
  Radar,
  Trash2,
  UserCheck,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { EVENT_META, TRACK_OPTIONS } from "@/lib/event-meta";
import { formatCompact, timeAgo, type WatchAccount, type EventType } from "@/lib/types";

interface WatchlistProps {
  accounts: WatchAccount[];
  onChanged: () => void;
}

/**
 * Watchlist manager — left sidebar of the split workspace. Compact target
 * cards: avatar · display name · handle · live follower count · pause toggle ·
 * per-account "Sweep" button (sweeps just that account) · remove.
 */
export function Watchlist({ accounts, onChanged }: WatchlistProps) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [sweepingId, setSweepingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WatchAccount | null>(null);
  const { toast } = useToast();

  const patchAccount = async (id: string, patch: Partial<WatchAccount>, okMsg?: string) => {
    setPendingId(id);
    try {
      const res = await fetch(`/api/accounts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast({ title: "Update failed", description: data?.error, variant: "destructive" });
      } else if (okMsg) {
        toast({ title: okMsg });
      }
      onChanged();
    } catch {
      toast({ title: "Network error", variant: "destructive" });
    } finally {
      setPendingId(null);
    }
  };

  const removeAccount = async (account: WatchAccount) => {
    setPendingId(account.id);
    try {
      const res = await fetch(`/api/accounts/${account.id}`, { method: "DELETE" });
      if (!res.ok) {
        toast({ title: "Delete failed", variant: "destructive" });
      } else {
        toast({ title: `Removed @${account.username}`, description: "No longer monitored." });
      }
      onChanged();
    } catch {
      toast({ title: "Network error", variant: "destructive" });
    } finally {
      setPendingId(null);
      setDeleteTarget(null);
    }
  };

  /** Sweep ONE account now (POST /api/scan with accountId). */
  const sweepAccount = async (account: WatchAccount) => {
    setSweepingId(account.id);
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.error) {
        toast({
          title: "Sweep failed",
          description: data?.error ?? `HTTP ${res.status}`,
          variant: "destructive",
        });
      } else if (data?.status === "skipped") {
        toast({ title: "Sweep skipped", description: "A full sweep is already running." });
      } else {
        toast({
          title: `Swept @${account.username}`,
          description: `${data.eventsFound ?? 0} new event${(data.eventsFound ?? 0) === 1 ? "" : "s"} · ${data.mode ?? "-"} mode`,
        });
      }
      onChanged();
    } catch {
      toast({ title: "Network error", variant: "destructive" });
    } finally {
      setSweepingId(null);
    }
  };

  return (
    <Card className="panel overflow-hidden rounded-xl border-border">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-foreground">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[#10b981]/10 ring-1 ring-[#10b981]/25">
            <UserCheck className="h-3.5 w-3.5 text-[#10b981]" aria-hidden />
          </span>
          Watchlist
          <span className="ml-auto rounded-full border border-border bg-secondary px-2 py-0.5 font-mono text-[11px] font-normal normal-case tracking-normal text-muted-foreground">
            {accounts.length} account{accounts.length === 1 ? "" : "s"}
          </span>
        </CardTitle>
        <CardDescription className="text-xs text-muted-foreground">
          Toggle tracking, sweep one account, pause or remove anytime.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {accounts.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border py-10 text-center">
            <UserCheck className="h-8 w-8 text-muted-foreground/40" aria-hidden />
            <p className="text-sm font-medium text-muted-foreground">Nobody on the radar yet</p>
            <p className="max-w-[240px] text-xs text-muted-foreground/70">
              Add an @handle above and TweetRadar will start sweeping it within seconds.
            </p>
          </div>
        ) : (
          // NATIVE scroll — the Radix ScrollArea viewport failed to clip under
          // max-h, letting rows paint over the cards below (2026-10-03 bug).
          <div className="scroll-slim max-h-[calc(100vh-19rem)] min-h-[200px] overflow-y-auto pr-1.5">
            <ul className="space-y-2">
              {accounts.map((account) => {
                const busy = pendingId === account.id;
                const sweeping = sweepingId === account.id;
                return (
                  <li
                    key={account.id}
                    className={`group rounded-xl border p-3 transition-all duration-200 ${
                      account.active
                        ? "border-border bg-secondary/40 hover:border-[#10b981]/30 hover:bg-[#10b981]/[0.04]"
                        : "border-border/60 bg-secondary/20 opacity-60 hover:border-border"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      {/* Avatar */}
                      <div
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white ring-1 ring-border"
                        style={{ backgroundColor: account.avatarColor ?? "#1d9bf0" }}
                        aria-hidden
                      >
                        {(account.displayName ?? account.username).charAt(0).toUpperCase()}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-semibold text-foreground">
                            {account.displayName ?? account.username}
                          </span>
                          <a
                            href={`https://x.com/${account.username}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-primary"
                            title={`Open @${account.username} on X`}
                          >
                            @{account.username}
                            <ExternalLink className="h-2.5 w-2.5" aria-hidden />
                          </a>
                        </div>
                        <div className="truncate text-[11px] text-muted-foreground tabular-nums">
                          {account.followersCount != null
                            ? `${formatCompact(account.followersCount)} followers`
                            : "followers pending sweep"}
                          {" · "}
                          {account.eventCount} event{account.eventCount === 1 ? "" : "s"}
                          {account.lastEventAt ? ` · last ${timeAgo(account.lastEventAt)}` : ""}
                        </div>
                      </div>

                      {busy && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />}

                      <Switch
                        checked={account.active}
                        onCheckedChange={(v) =>
                          patchAccount(account.id, { active: v }, v ? `Resumed @${account.username}` : `Paused @${account.username}`)
                        }
                        disabled={busy}
                        aria-label={account.active ? `Pause monitoring @${account.username}` : `Resume monitoring @${account.username}`}
                      />

                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 shrink-0 text-muted-foreground hover:bg-rose-500/10 hover:text-[#f43f5e]"
                        onClick={() => setDeleteTarget(account)}
                        disabled={busy}
                        aria-label={`Remove @${account.username} from watchlist`}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    </div>

                    {/* Tracking chips + per-account sweep */}
                    <div className="mt-2.5 flex flex-wrap items-center gap-1">
                      {TRACK_OPTIONS.map((opt) => {
                        const on = account[opt.key];
                        const meta = EVENT_META[opt.type as EventType];
                        return (
                          <button
                            key={opt.key}
                            onClick={() => patchAccount(account.id, { [opt.key]: !on } as Partial<WatchAccount>)}
                            disabled={busy}
                            title={`${on ? "Stop tracking" : "Track"} ${meta.label.toLowerCase()} — ${opt.hint}`}
                            aria-pressed={on}
                            className={`rounded-full border px-2 py-0.5 text-[10px] font-medium transition-all ${
                              on
                                ? `${meta.bg} ${meta.color} ${meta.border}`
                                : "border-border bg-transparent text-muted-foreground/60 hover:border-muted-foreground/40 hover:text-muted-foreground"
                            }`}
                          >
                            {meta.label}
                          </button>
                        );
                      })}

                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => sweepAccount(account)}
                        disabled={sweeping || busy || !account.active}
                        title={account.active ? "Check this account right now" : "Resume the account to enable sweeping"}
                        className="ml-auto h-6 gap-1 rounded-full border-border px-2.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground hover:border-[#1d9bf0]/40 hover:text-primary"
                      >
                        {sweeping ? (
                          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                        ) : (
                          <Radar className="h-3 w-3" aria-hidden />
                        )}
                        Sweep
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </CardContent>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent className="border-border bg-card text-card-foreground">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove @{deleteTarget?.username}?</AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              This stops 24/7 monitoring and deletes all captured activity for this account.
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-border bg-secondary hover:bg-accent">
              <Pause className="mr-1 h-4 w-4" /> Keep watching
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-[#f43f5e] text-white hover:bg-[#e11d48]"
              onClick={() => deleteTarget && removeAccount(deleteTarget)}
            >
              <Trash2 className="mr-1 h-4 w-4" /> Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
