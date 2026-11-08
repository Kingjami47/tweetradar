/**
 * Telegram Bot API notifier — high-signal alert formats.
 *
 * Notification routing (the radar keeps EVERYTHING on the dashboard; Telegram
 * only pings for high-value actions, per the user's notification scope):
 *   📲 Pings Telegram : new follows, original posts (quotes count as posts)
 *   💻 Dashboard only : replies, reposts, profile edits, likes
 * All four categories are toggleable in Settings → Notification scope
 * (notifyOnFollows / notifyOnPosts / notifyOnReplies / notifyOnReposts).
 */

export interface TelegramResult {
  ok: boolean;
  error?: string;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Send a raw HTML message. Returns ok/error without throwing.
 *
 * opts.previewUrl pins Telegram's link-preview card to that URL — for tweet
 * alerts this unfurls the REAL post page, so the card itself shows the tweet
 * text (+ photo) and the reader can decide whether to tap through. Without a
 * previewUrl the card is hidden entirely, keeping command replies and follow
 * digests clean (no stray emoji-image cards).
 */
export async function sendTelegramHtml(
  botToken: string,
  chatId: string,
  html: string,
  opts?: { previewUrl?: string | null }
): Promise<TelegramResult> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: html,
        parse_mode: "HTML",
        link_preview_options: opts?.previewUrl
          ? { url: opts.previewUrl }
          : { is_visible: false },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => null)) as
      | { ok: boolean; description?: string }
      | null;
    if (!res.ok || !data?.ok) {
      return { ok: false, error: data?.description || `Telegram HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

export type EventType =
  | "POST"
  | "REPOST"
  | "REPLY"
  | "QUOTE"
  | "LIKE"
  | "FOLLOW"
  | "PROFILE";

// ---------------------------------------------------------------------------
// Notification routing — the high-signal filter
// ---------------------------------------------------------------------------

export interface NotifyPrefs {
  notifyOnFollows: boolean;
  notifyOnPosts: boolean;
  notifyOnReplies: boolean;
  notifyOnReposts: boolean;
}

export const NOTIFY_PREFS_KEYS = [
  "notifyOnFollows",
  "notifyOnPosts",
  "notifyOnReplies",
  "notifyOnReposts",
] as const;

/** Event types that NEVER ping Telegram regardless of toggles. */
export const DASHBOARD_ONLY_TYPES: EventType[] = ["REPLY", "REPOST", "PROFILE", "LIKE"];

/**
 * Strict routing gate: should this event type ping Telegram?
 * FOLLOW → follows toggle · POST + QUOTE → posts toggle (a quote is the
 * target's own post) · REPLY → replies toggle · REPOST → reposts toggle ·
 * LIKE / PROFILE → dashboard only, always.
 */
export function shouldPingTelegram(type: EventType, prefs: NotifyPrefs): boolean {
  switch (type) {
    case "FOLLOW":
      return prefs.notifyOnFollows;
    case "POST":
    case "QUOTE":
      return prefs.notifyOnPosts;
    case "REPLY":
      return prefs.notifyOnReplies;
    case "REPOST":
      return prefs.notifyOnReposts;
    default:
      return false; // LIKE, PROFILE — dashboard only
  }
}

// ---------------------------------------------------------------------------
// Clean alert formats
// ---------------------------------------------------------------------------

export interface AlertMetrics {
  likes: number;
  retweets: number;
  replies: number;
  views: number;
}

/**
 * Title subject: display name (when the watchlist knows it) + a tappable
 * profile link, so an alert answers "WHO posted" at a glance — not everyone
 * remembers what @Xeetbtcvox is. Name missing → bold linked handle only.
 */
function who(username: string, displayName?: string | null): string {
  const handle = `https://x.com/${encodeURIComponent(username)}`;
  const handleLink = `<a href="${handle}"><b>@${escapeHtml(username)}</b></a>`;
  const name = displayName?.trim();
  if (name && name !== username) {
    return `<b>${escapeHtml(name)}</b> (${handleLink})`;
  }
  return handleLink;
}

/** Tappable link to another account's profile (reply/repost authors, digest entries). */
function profileLink(handle: string, bold = true): string {
  const h = handle.replace(/^@/, "");
  const inner = `<b>@${escapeHtml(h)}</b>`;
  return `<a href="https://x.com/${encodeURIComponent(h)}">${bold ? inner : `@${escapeHtml(h)}`}</a>`;
}

/**
 * v5 alert header — every alert opens with the same structured pattern:
 *   EMOJI <b>CATEGORY</b> — subject
 * The CAPS tag makes the event type scannable in the chat list preview and
 * the notification tray; the subject (name + linked handle) answers "who".
 */
function header(emoji: string, tag: string, subject: string): string {
  return `${emoji} <b>${tag}</b> — ${subject}`;
}

/**
 * Engagement line — likes · reposts · replies · views when X reported them.
 * Gives the reader instant heat-signal ("2.1K likes in 10 min = look NOW")
 * before deciding to tap through. Bare line, or "" when all zeros/absent.
 */
function metricsLine(m?: AlertMetrics | null): string {
  if (!m) return "";
  const parts: string[] = [];
  if (m.likes > 0) parts.push(`❤️ ${formatFollowers(m.likes)}`);
  if (m.retweets > 0) parts.push(`🔁 ${formatFollowers(m.retweets)}`);
  if (m.replies > 0) parts.push(`💬 ${formatFollowers(m.replies)}`);
  if (m.views > 0) parts.push(`👁 ${formatFollowers(m.views)}`);
  return parts.join(" · ");
}

/**
 * Code-point-safe truncation — String#slice can split a surrogate pair (an
 * emoji astride the cut), producing a lone surrogate that Telegram can reject
 * or render as garbage. Twitter text is emoji-heavy, so always cut on full
 * code points ([...str] iterates code points, not UTF-16 units).
 */
function truncateCodePoints(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, max - 1).join("") + "…";
}

/**
 * Tweet text as a readable Telegram quote block: HTML-escaped, original line
 * breaks preserved (multi-line posts stay scannable), capped at `max` chars.
 * Long posts use an expandable blockquote — Telegram collapses it to a few
 * lines with a tap-to-expand, so even 2,000-character posts never flood the
 * chat. The block itself IS the preview: the reader sees what was posted and
 * decides whether to open the link.
 */
function quoteBlock(text: string | null | undefined, max: number): string {
  if (!text) return "";
  const clean = text.replace(/\n{3,}/g, "\n\n").trim();
  const clipped = clean.length > max ? truncateCodePoints(clean, max).trimEnd() : clean;
  return clipped.length > 400
    ? `<blockquote expandable>${escapeHtml(clipped)}</blockquote>`
    : `<blockquote>${escapeHtml(clipped)}</blockquote>`;
}

/** Tappable post link rendered as the bare URL (clean + obviously clickable). */
function linkLine(url: string | null | undefined): string {
  if (!url) return "";
  return `🔗 <a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
}

/**
 * Rewrite tweet deep-links to the login-free FixTweet mirror — used for the
 * Telegram PREVIEW pin only (the 🔗 link and DB + dashboard keep the
 * canonical x.com URL).
 *
 * Why: x.com serves Telegram's crawler an empty JS shell (X blocks crawling
 * without login), so the preview card under an alert is bare. fxtwitter.com
 * hands the crawler the full og-card — tweet text, photo, metrics — so the
 * post unfurls richly inside the chat. Note the mirror is NOT for the tap
 * link: fxtwitter redirects real browsers back to x.com. Profiles and
 * non-x.com hosts pass through untouched.
 */
export function mirrorTweetUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  const isXHost =
    host === "x.com" || host === "twitter.com" || host === "mobile.x.com" || host === "mobile.twitter.com";
  if (!isXHost) return url;
  // Matches /status/<id>, /i/status/<id> and /<handle>/status/<id>
  if (!/^\/(?:[^/]+\/)?(?:status|statuses)\/\d+/.test(parsed.pathname)) return url;
  parsed.hostname = "fxtwitter.com";
  return parsed.toString();
}

/**
 * Title + optional sections (quote → metrics → link), separated by exactly
 * one blank line and never leaving stray gaps when a section is absent.
 */
function assemble(title: string, quote: string, extras: string[]): string {
  const sections = [quote, ...extras].filter((s) => s.length > 0);
  return sections.length ? `${title}\n\n${sections.join("\n\n")}` : title;
}

/**
 * 📝 Original post alert (also used for QUOTE — a quote is the target's own
 * posted content). Built for read-first, click-second:
 *   📝 @target just posted:
 *
 *   ▐ The full tweet text sits in a quote block — line breaks kept, long
 *   ▐ posts collapse to a tap-to-expand — so the reader can judge the post
 *   ▐ without opening X.
 *
 *   🔗 https://x.com/target/status/123456789
 * On top of that, deliverAlert pins the link-preview card to the tweet URL,
 * so Telegram renders the actual post (text + photo) beneath the message.
 */
export function buildPostAlert(opts: {
  username: string;
  displayName?: string | null;
  text?: string | null;
  url?: string | null;
  metrics?: AlertMetrics | null;
}): string {
  return assemble(header("📝", "NEW POST", who(opts.username, opts.displayName)), quoteBlock(opts.text, 800), [
    metricsLine(opts.metrics),
    linkLine(opts.url),
  ]);
}

/**
 * 🚨 New-follow alert — all follows detected in one sweep are batched into a
 * single digest, ENRICHED with each followed account's real public profile
 * (keyless fetch) so the reader can judge WHO was followed at a glance.
 *
 * v5 digest layout — one self-contained block per followed account, built to
 * scan vertically like a leaderboard instead of a wall of quoted text:
 *
 *   🚨 <b>NEW FOLLOWS</b> — 10 accounts
 *   <b>scenes</b> (@degenscenes) just followed:
 *
 *   <b>1.</b> <a>Rarelist</a> — @rarelistio — 👥 5,456
 *   A curated launch platform. Creator campaigns & rewards.   (italic line)
 *
 *   <b>2.</b> <a>@giwabroker</a> — 👥 41
 *   3,333 NFTs Broker Coming on @giwa_by_upbit
 *
 * Design rules:
 *   · identity line = index + bold linked name + plain @handle + reach
 *   · bio sits on ITS OWN italic line (no wrapped quotes — the italics carry
 *     the distinction), truncated at a WORD boundary, never mid-word
 *   · blank line between entries so 10 accounts don't melt into one blob
 *   · bare handles (enrichment failed) degrade to a bold linked handle
 */
export interface FollowTargetInfo {
  handle: string;
  name?: string | null;
  bio?: string | null;
  followers?: number | null;
}

/** 12400 → "12.4K" · 2100000 → "2.1M" · 15000000 → "15M" · 8432 → "8,432" */
export function formatFollowers(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  }
  if (n >= 10_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return n.toLocaleString("en-US");
}

/** Bio ready for display: collapse whitespace, strip wrapping quotes, word-safe cut. */
function cleanBio(bio: string, max = 120): string {
  let b = bio.replace(/\s+/g, " ").trim();
  b = b.replace(/^["“”'«»]+/, "").replace(/["“”'«»]+$/, "").trim();
  if (b.length > max) {
    b = Array.from(b).slice(0, max).join("");
    const cut = b.lastIndexOf(" ");
    if (cut > max * 0.6) b = b.slice(0, cut);
    b = `${b.trimEnd()}…`;
  }
  return b;
}

const FOLLOW_DIGEST_MAX = 10;

export function buildFollowDigestAlert(opts: {
  username: string;
  displayName?: string | null;
  targets: (string | FollowTargetInfo)[];
}): string {
  const targets = opts.targets.map((t) => (typeof t === "string" ? { handle: t } : t));
  const shown = targets.slice(0, FOLLOW_DIGEST_MAX);
  const numbered = shown.length > 1;

  const blocks = shown.map((t, i) => {
    const handle = t.handle.replace(/^@/, "");
    const reach =
      typeof t.followers === "number" && Number.isFinite(t.followers)
        ? ` — 👥 ${formatFollowers(t.followers)}`
        : "";
    const name = t.name?.trim();
    const num = numbered ? `<b>${i + 1}.</b> ` : "";
    const head = name && name !== handle
      ? `${num}<a href="https://x.com/${encodeURIComponent(handle)}"><b>${escapeHtml(name)}</b></a> — <i>@${escapeHtml(handle)}</i>${reach}`
      : `${num}${profileLink(handle)}${reach}`;
    const bio = t.bio ? cleanBio(t.bio) : "";
    return bio ? `${head}\n<i>${escapeHtml(bio)}</i>` : head;
  });

  const extra =
    targets.length > shown.length
      ? `\n\n… ${targets.length - shown.length} more — full list on the dashboard`
      : "";

  const tag = targets.length === 1 ? "NEW FOLLOW" : `NEW FOLLOWS — ${targets.length} account${targets.length === 1 ? "" : "s"}`;
  return `${header("🚨", tag, who(opts.username, opts.displayName))} just followed:\n\n${blocks.join("\n\n")}${extra}`;
}

/** 💬 Reply alert — only sent when notifyOnReplies is enabled. Target is tappable. */
export function buildReplyAlert(opts: {
  username: string;
  displayName?: string | null;
  text?: string | null;
  url?: string | null;
  targetUser?: string | null;
  metrics?: AlertMetrics | null;
}): string {
  const to = opts.targetUser ? ` → ${profileLink(opts.targetUser)}` : "";
  return assemble(header("💬", "REPLY", who(opts.username, opts.displayName) + to), quoteBlock(opts.text, 400), [
    metricsLine(opts.metrics),
    linkLine(opts.url),
  ]);
}

/** 🔁 Repost alert — only sent when notifyOnReposts is enabled. Author is tappable. */
export function buildRepostAlert(opts: {
  username: string;
  displayName?: string | null;
  text?: string | null;
  url?: string | null;
  targetUser?: string | null;
  metrics?: AlertMetrics | null;
}): string {
  const from = opts.targetUser ? ` → ${profileLink(opts.targetUser)}` : "";
  return assemble(header("🔁", "REPOST", who(opts.username, opts.displayName) + from), quoteBlock(opts.text, 400), [
    metricsLine(opts.metrics),
    linkLine(opts.url),
  ]);
}

/**
 * Build the alert for a single (non-follow) event, routed per notification
 * scope. Returns null when the type is dashboard-only under current prefs.
 */
export function buildRoutedAlert(opts: {
  type: EventType;
  username: string;
  displayName?: string | null;
  text?: string | null;
  url?: string | null;
  targetUser?: string | null;
  metrics?: AlertMetrics | null;
  prefs: NotifyPrefs;
}): string | null {
  if (!shouldPingTelegram(opts.type, opts.prefs)) return null;
  const base = {
    username: opts.username,
    displayName: opts.displayName,
    text: opts.text,
    url: opts.url,
    metrics: opts.metrics,
  };
  switch (opts.type) {
    case "POST":
    case "QUOTE":
      return buildPostAlert(base);
    case "REPLY":
      return buildReplyAlert({ ...base, targetUser: opts.targetUser });
    case "REPOST":
      return buildRepostAlert({ ...base, targetUser: opts.targetUser });
    default:
      return null; // FOLLOW uses buildFollowDigestAlert (batched)
  }
}

/** Build a simple custom alert (used by "send test alert"). */
export function buildTestAlert(): string {
  return (
    "📡 <b>TWEETRADAR</b> — <b>SYSTEM CHECK</b>\n\n" +
    "✅ Test alert — your Telegram channel is wired up!\n\n" +
    "You will now receive instant pings for high-signal actions — new follows and original posts — per your notification scope. Everything else still lands on the dashboard."
  );
}
