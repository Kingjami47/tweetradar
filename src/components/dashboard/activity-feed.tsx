"use client";

import { Fragment, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Bird,
  ExternalLink,
  Heart,
  MessageCircle,
  Quote,
  Repeat2,
  UserCog,
  UserPlus,
  Users,
  Waves,
  BellRing,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EVENT_META } from "@/lib/event-meta";
import { timeAgo, type ActivityItem, type EventType } from "@/lib/types";

const TYPE_ICON: Record<EventType, typeof Bird> = {
  POST: Bird,
  REPOST: Repeat2,
  REPLY: MessageCircle,
  QUOTE: Quote,
  LIKE: Heart,
  FOLLOW: UserPlus,
  PROFILE: UserCog,
};

/** Spec filter tabs: All · 🚨 Follows · 📝 Posts · 💬 Replies/Edits. */
const FILTERS: { value: string; label: string; types: EventType[] | null }[] = [
  { value: "all", label: "All", types: null },
  { value: "follows", label: "🚨 Follows", types: ["FOLLOW"] },
  { value: "posts", label: "📝 Posts", types: ["POST", "QUOTE", "REPOST"] },
  { value: "replies", label: "💬 Replies/Edits", types: ["REPLY", "PROFILE", "LIKE"] },
];

interface ActivityFeedProps {
  events: ActivityItem[];
  loading: boolean;
}

/**
 * XSS-safe rich text: bolds @handles (linking their profile) and turns bare
 * URLs into real links. Built with React elements — no HTML injection.
 */
function RichText({ text }: { text: string }) {
  const parts = useMemo(() => {
    const regex = /(@[A-Za-z0-9_]{1,15})|(https?:\/\/[^\s]+)/g;
    const out: { kind: "handle" | "url" | "plain"; value: string }[] = [];
    let last = 0;
    for (const m of text.matchAll(regex)) {
      const idx = m.index ?? 0;
      if (idx > last) out.push({ kind: "plain", value: text.slice(last, idx) });
      if (m[1]) out.push({ kind: "handle", value: m[1] });
      else out.push({ kind: "url", value: m[2] });
      last = idx + m[0].length;
    }
    if (last < text.length) out.push({ kind: "plain", value: text.slice(last) });
    return out;
  }, [text]);

  return (
    <>
      {parts.map((p, i) => {
        if (p.kind === "handle") {
          return (
            <a
              key={i}
              href={`https://x.com/${p.value.slice(1)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-primary hover:underline"
            >
              {p.value}
            </a>
          );
        }
        if (p.kind === "url") {
          return (
            <a
              key={i}
              href={p.value}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              {p.value.replace(/^https?:\/\//, "").slice(0, 40)}
            </a>
          );
        }
        return <Fragment key={i}>{p.value}</Fragment>;
      })}
    </>
  );
}

function describeEvent(e: ActivityItem): string {
  switch (e.type) {
    case "POST":
      return "posted";
    case "REPOST":
      return "reposted";
    case "REPLY":
      return "replied";
    case "QUOTE":
      return "quoted a post";
    case "LIKE":
      return `liked a post${e.targetUser ? ` by @${e.targetUser}` : ""}`;
    case "FOLLOW":
      return `started following @${e.targetUser ?? "someone"}`;
    case "PROFILE":
      return "profile update";
    default:
      return `@${e.account.username}`;
  }
}

export function ActivityFeed({ events, loading }: ActivityFeedProps) {
  const [filter, setFilter] = useState<string>("all");
  const activeTypes = FILTERS.find((f) => f.value === filter)?.types ?? null;
  const filtered = activeTypes ? events.filter((e) => activeTypes.includes(e.type)) : events;

  return (
    <Card className="panel flex h-full flex-col overflow-hidden rounded-xl border-border">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-foreground">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[#1d9bf0]/10 ring-1 ring-[#1d9bf0]/25">
            <Waves className="h-3.5 w-3.5 text-[#1d9bf0]" aria-hidden />
          </span>
          Live activity feed
          {loading && (
            <span className="relative flex h-2 w-2" aria-label="Refreshing">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#10b981] opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[#10b981]" />
            </span>
          )}
          <span className="ml-auto rounded-full border border-border bg-secondary px-2 py-0.5 font-mono text-[11px] font-normal normal-case tracking-normal text-muted-foreground">
            {filtered.length} event{filtered.length === 1 ? "" : "s"}
          </span>
        </CardTitle>
        <CardDescription className="text-xs text-muted-foreground">
          Everything the radar picks up, newest first. Bell = Telegram alert delivered.
        </CardDescription>

        <div className="flex flex-wrap gap-1.5 pt-1" role="tablist" aria-label="Filter activity by type">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              role="tab"
              aria-selected={filter === f.value}
              onClick={() => setFilter(f.value)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-all ${
                filter === f.value
                  ? "border-[#1d9bf0]/40 bg-[#1d9bf0]/10 text-[#1d9bf0] shadow-[0_0_12px_-4px_rgba(29,155,240,0.5)]"
                  : "border-border text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </CardHeader>

      <CardContent className="min-h-0 flex-1">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border py-14 text-center">
            <Waves className="h-8 w-8 text-muted-foreground/40" aria-hidden />
            <p className="text-sm font-medium text-muted-foreground">
              {events.length === 0 ? "Listening for activity…" : "Nothing under this filter yet"}
            </p>
            <p className="max-w-[280px] text-xs text-muted-foreground/70">
              {events.length === 0
                ? "Add accounts to the watchlist — detected events land here in real time."
                : "Try a different filter."}
            </p>
          </div>
        ) : (
          // NATIVE scroll — replaces Radix ScrollArea (viewport clipping failure
          // let rows bleed over sibling cards). See watchlist.tsx note.
          <div className="scroll-slim max-h-[calc(100vh-19rem)] min-h-[200px] overflow-y-auto pr-1.5">
            <ul className="space-y-2.5" aria-live="polite">
              <AnimatePresence initial={false}>
                {filtered.map((e) => {
                  const meta = EVENT_META[e.type];
                  return (
                    <motion.li
                      key={e.id}
                      layout
                      initial={{ opacity: 0, y: -8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.25 }}
                      className="rounded-xl border border-border bg-secondary/30 p-3.5 transition-colors hover:border-muted-foreground/25"
                    >
                      {/* Row 1 — identity + event badge */}
                      <div className="flex items-start gap-3">
                        <div
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white ring-1 ring-border"
                          style={{ backgroundColor: e.account.avatarColor ?? "#1d9bf0" }}
                          aria-hidden
                        >
                          {(e.account.displayName ?? e.account.username).charAt(0).toUpperCase()}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                            <span className="truncate text-sm font-bold text-foreground">
                              {e.account.displayName ?? e.account.username}
                            </span>
                            <span className="truncate text-xs text-muted-foreground">
                              @{e.account.username}
                            </span>
                            <span className="text-xs text-muted-foreground/60">·</span>
                            <span
                              className="shrink-0 text-xs text-muted-foreground tabular-nums"
                              title={new Date(e.detectedAt).toLocaleString()}
                            >
                              {timeAgo(e.detectedAt)}
                            </span>
                            <span
                              className={`ml-auto shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold tracking-wide ${meta.bg} ${meta.color} ${meta.border}`}
                            >
                              {meta.badge}
                            </span>
                          </div>

                          {/* Row 2 — what happened */}
                          <p className="mt-0.5 text-xs text-muted-foreground">{describeEvent(e)}</p>

                          {/* Row 3 — full text with bold handles + clickable links */}
                          {e.text && (
                            <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90">
                              <RichText text={e.text} />
                            </p>
                          )}

                          {/* Row 4 — target / metrics / delivered / action */}
                          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                            {e.type === "FOLLOW" && e.targetUser && (
                              <a
                                href={`https://x.com/intent/follow?screen_name=${encodeURIComponent(e.targetUser)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 rounded-full border border-[#10b981]/30 bg-[#10b981]/10 px-2 py-0.5 font-semibold text-[#10b981] transition-colors hover:bg-[#10b981]/20"
                              >
                                <Users className="h-3 w-3" aria-hidden /> Follow @{e.targetUser}
                              </a>
                            )}
                            {e.notified && (
                              <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-amber-500">
                                <BellRing className="h-3 w-3" aria-hidden /> Telegram sent
                              </span>
                            )}
                            {e.metrics && (
                              <>
                                {typeof e.metrics.likes === "number" && e.metrics.likes > 0 && (
                                  <span className="rounded bg-secondary px-1.5 py-0.5 font-mono tabular-nums">♥ {e.metrics.likes.toLocaleString()}</span>
                                )}
                                {typeof e.metrics.retweets === "number" && e.metrics.retweets > 0 && (
                                  <span className="rounded bg-secondary px-1.5 py-0.5 font-mono tabular-nums">⟳ {e.metrics.retweets.toLocaleString()}</span>
                                )}
                                {typeof e.metrics.replies === "number" && e.metrics.replies > 0 && (
                                  <span className="rounded bg-secondary px-1.5 py-0.5 font-mono tabular-nums">💬 {e.metrics.replies.toLocaleString()}</span>
                                )}
                                {typeof e.metrics.views === "number" && e.metrics.views > 0 && (
                                  <span className="rounded bg-secondary px-1.5 py-0.5 font-mono tabular-nums">👁 {e.metrics.views.toLocaleString()}</span>
                                )}
                                {typeof e.metrics.followers === "number" && (
                                  <span className="rounded bg-secondary px-1.5 py-0.5 font-mono tabular-nums">👥 {e.metrics.followers.toLocaleString()}</span>
                                )}
                              </>
                            )}

                            {e.url && (
                              <a
                                href={e.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={`Open the actual ${e.type === "FOLLOW" ? "account" : "post"} on X`}
                                className="ml-auto inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 font-semibold text-foreground transition-all hover:border-[#1d9bf0]/40 hover:text-[#1d9bf0]"
                              >
                                Open on X <ExternalLink className="h-3 w-3" aria-hidden />
                              </a>
                            )}
                          </div>
                        </div>
                      </div>
                    </motion.li>
                  );
                })}
              </AnimatePresence>
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
