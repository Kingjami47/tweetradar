"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { BadgeCheck, CircleUserRound, ExternalLink, UserPlus, X, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { timeAgo, type DiscoveredItem } from "@/lib/types";

const DISMISS_KEY = "tweetradar-dismissed";

function loadDismissed(): string[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(DISMISS_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

interface SmartCircleProps {
  items: DiscoveredItem[];
  onChanged: () => void;
}

export function SmartCircle({ items, onChanged }: SmartCircleProps) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [tracking, setTracking] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    setDismissed(loadDismissed());
  }, []);

  const visible = items.filter(
    (d) => !dismissed.includes(d.targetUser.toLowerCase()) && !d.tracked
  );

  const dismiss = (target: string) => {
    const next = Array.from(new Set([...dismissed, target.toLowerCase()]));
    setDismissed(next);
    window.localStorage.setItem(DISMISS_KEY, JSON.stringify(next));
  };

  const track = async (target: string) => {
    setTracking(target);
    try {
      const res = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: target }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: "Could not track", description: data.error, variant: "destructive" });
        return;
      }
      toast({
        title: `Now tracking @${target}`,
        description: "Added to your watchlist — sweeps start immediately.",
      });
      onChanged();
    } catch {
      toast({ title: "Network error", variant: "destructive" });
    } finally {
      setTracking(null);
    }
  };

  const trackedCount = items.filter((d) => d.tracked).length;

  return (
    <Card className="panel rounded-xl border-border">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-foreground">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[#10b981]/10 ring-1 ring-[#10b981]/25">
            <CircleUserRound className="h-3.5 w-3.5 text-[#10b981]" aria-hidden />
          </span>
          Smart Circle
          <span className="ml-auto rounded-full border border-border bg-secondary px-2 py-0.5 font-mono text-[11px] font-normal normal-case tracking-normal text-muted-foreground">
            {visible.length} new · {trackedCount} tracked
          </span>
        </CardTitle>
        <CardDescription className="text-xs text-muted-foreground">
          Who your watchlist just started following. Follow them too in one click, or add them to
          the radar.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border py-8 text-center">
            <UserPlus className="h-7 w-7 text-muted-foreground/40" aria-hidden />
            <p className="text-sm font-medium text-muted-foreground">No discoveries yet</p>
            <p className="max-w-[260px] text-xs text-muted-foreground/70">
              When a watched account follows someone new, that account lands here with one-click
              follow.
            </p>
          </div>
        ) : visible.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border py-6 text-center text-sm text-muted-foreground">
            All caught up — every discovered account is tracked or dismissed.
          </p>
        ) : (
          <div className="scroll-slim max-h-[360px] overflow-y-auto pr-1.5">
            <ul className="space-y-2" aria-label="Discovered accounts">
            <AnimatePresence initial={false}>
              {visible.slice(0, 12).map((d) => (
                <motion.li
                  key={d.targetUser.toLowerCase()}
                  layout
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                  transition={{ duration: 0.2 }}
                  className="rounded-xl border border-[#10b981]/15 bg-[#10b981]/[0.05] p-2.5"
                >
                  <div className="flex items-center gap-2.5">
                    <div
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#10b981]/15 text-xs font-bold text-[#10b981] ring-1 ring-[#10b981]/20"
                      aria-hidden
                    >
                      {d.targetUser.charAt(0).toUpperCase()}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <a
                          href={`https://x.com/${encodeURIComponent(d.targetUser)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="truncate text-sm font-semibold text-foreground hover:text-[#10b981]"
                        >
                          @{d.targetUser}
                        </a>
                        <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        via @{d.via.join(", @")} · {timeAgo(d.lastAt)}
                        {d.timesSeen > 1 ? ` · seen ${d.timesSeen}x` : ""}
                      </div>
                    </div>

                    {tracking === d.targetUser && (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#10b981]" />
                    )}
                  </div>

                  {tracking !== d.targetUser && (
                    <div className="mt-2 flex items-center gap-1.5 border-t border-[#10b981]/10 pt-2">
                      <Button
                        size="sm"
                        className="h-7 gap-1 bg-[#1d9bf0] px-2.5 text-[11px] font-semibold text-white hover:bg-[#1a8cd8]"
                        onClick={() =>
                          window.open(
                            `https://x.com/intent/follow?screen_name=${encodeURIComponent(d.targetUser)}`,
                            "_blank",
                            "noopener"
                          )
                        }
                        aria-label={`Follow @${d.targetUser} on X`}
                      >
                        <UserPlus className="h-3.5 w-3.5" />
                        Follow
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 border-border px-2.5 text-[11px] text-foreground hover:bg-accent"
                        onClick={() => track(d.targetUser)}
                        aria-label={`Add @${d.targetUser} to watchlist`}
                      >
                        <BadgeCheck className="h-3.5 w-3.5" />
                        Track
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="ml-auto h-7 w-7 text-muted-foreground hover:bg-accent hover:text-foreground"
                        onClick={() => dismiss(d.targetUser)}
                        aria-label={`Dismiss @${d.targetUser}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                </motion.li>
              ))}
            </AnimatePresence>
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
