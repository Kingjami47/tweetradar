"use client";

import { useState } from "react";
import { Plus, AtSign, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Toggle } from "@/components/ui/toggle";
import { useToast } from "@/hooks/use-toast";
import { TRACK_OPTIONS } from "@/lib/event-meta";
import type { EventType } from "@/lib/types";

interface AddAccountCardProps {
  onAdded: () => void;
  disabled?: boolean;
}

export function AddAccountCard({ onAdded, disabled }: AddAccountCardProps) {
  const [username, setUsername] = useState("");
  const [tracks, setTracks] = useState<Record<string, boolean>>({
    trackPosts: true,
    trackReplies: true,
    trackReposts: true,
    trackLikes: false,
    trackFollows: true,
  });
  const [submitting, setSubmitting] = useState(false);
  const { toast } = useToast();

  const toggleTrack = (key: string) => setTracks((t) => ({ ...t, [key]: !t[key] }));

  /** "@naval, paulg; sama elonmusk" → ["naval","paulg","sama","elonmusk"] */
  const parseHandles = (raw: string): string[] =>
    raw
      .split(/[\s,;]+/)
      .map((tok) => tok.replace(/^@/, "").trim())
      .filter(Boolean);

  const submit = async () => {
    const handles = parseHandles(username);
    if (handles.length === 0) {
      toast({ title: "Enter a handle first", description: "Example: @elonmusk", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      // Single handle → original API (exact error text). Multiple → bulk API.
      if (handles.length === 1) {
        const res = await fetch("/api/accounts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: handles[0], ...tracks }),
        });
        const data = await res.json();
        if (!res.ok) {
          toast({ title: "Could not add account", description: data.error, variant: "destructive" });
          return;
        }
        toast({
          title: `Watching @${data.username ?? handles[0]}`,
          description: "The radar will sweep this account every cycle.",
        });
        setUsername("");
        onAdded();
        return;
      }

      if (handles.length > 25) {
        toast({
          title: "Too many handles",
          description: "Up to 25 per batch — split the list.",
          variant: "destructive",
        });
        return;
      }
      const res = await fetch("/api/accounts/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usernames: handles, ...tracks }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: "Bulk add failed", description: data.error, variant: "destructive" });
        return;
      }
      const addedList = (data.results as { ok: boolean; alreadyTracked?: boolean; username?: string; input: string; error?: string }[])
        ?? [];
      const added = addedList.filter((r) => r.ok && !r.alreadyTracked);
      const skipped = addedList.filter((r) => r.ok && r.alreadyTracked);
      const failed = addedList.filter((r) => !r.ok);
      const bits = [
        added.length ? `${added.length} added` : null,
        skipped.length ? `${skipped.length} already tracked` : null,
        failed.length ? `${failed.length} failed` : null,
      ].filter(Boolean);
      const firstFail = failed[0]?.error ? ` — ${failed[0].error}` : "";
      toast({
        title: `Bulk add: ${bits.join(" · ")}`,
        description: added.length
          ? `Now watching: ${added.map((r) => `@${r.username ?? r.input}`).join(" ").slice(0, 140)}${firstFail}`
          : (failed[0]?.error ?? "Nothing new to add."),
        variant: added.length ? undefined : failed.length ? "destructive" : undefined,
      });
      setUsername("");
      onAdded();
    } catch {
      toast({ title: "Network error", description: "Could not reach the server.", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="panel rounded-xl border-border">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-foreground">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[#1d9bf0]/10 ring-1 ring-[#1d9bf0]/25">
            <AtSign className="h-3.5 w-3.5 text-[#1d9bf0]" aria-hidden />
          </span>
          Add account to watch
        </CardTitle>
        <CardDescription className="text-xs text-muted-foreground">
          Drop one handle — or paste a whole list — and the radar checks them 24/7, pinging Telegram on new activity.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <AtSign className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="username — or paste a list: naval, paulg, sama"
              className="border-input bg-secondary/50 pl-9 text-foreground placeholder:text-muted-foreground/60 focus-visible:ring-[#1d9bf0]/40"
              aria-label="X/Twitter username(s) to watch"
              disabled={disabled || submitting}
              maxLength={600}
            />
          </div>
          <Button
            onClick={submit}
            disabled={disabled || submitting}
            className="gap-1.5 bg-[#1d9bf0] text-white shadow-[0_0_16px_-6px_rgba(29,155,240,0.8)] hover:bg-[#1a8cd8]"
            aria-label="Start watching this account"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            Watch
          </Button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {TRACK_OPTIONS.map((opt) => (
            <Toggle
              key={opt.key}
              pressed={tracks[opt.key]}
              onPressedChange={() => toggleTrack(opt.key)}
              size="sm"
              variant="outline"
              title={opt.hint}
              aria-pressed={tracks[opt.key]}
              className={`gap-1 rounded-full border-border text-xs data-[state=on]:border-[#1d9bf0]/40 data-[state=on]:bg-[#1d9bf0]/10 data-[state=on]:text-[#1d9bf0] data-[state=on]:shadow-[0_0_10px_-4px_rgba(29,155,240,0.6)]`}
            >
              {opt.type.charAt(0) + opt.type.slice(1).toLowerCase()}
            </Toggle>
          ))}
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Bulk: separate up to 25 handles with commas, spaces or new lines. Choose what to monitor
          (applies to the whole batch) — change it anytime per account. You can also add accounts
          straight from Telegram: send your bot <span className="font-mono text-foreground/70">+ @username</span>.
        </p>
      </CardContent>
    </Card>
  );
}

export type { EventType };
