/**
 * TweetRadar scan engine — 100% free, no developer-portal keys.
 * Every scan cycle iterates all active watched accounts:
 *  - SESSION mode (burner auth_token cookie set): real timeline reads via the
 *    x.com web-client GraphQL (UserTweetsAndReplies) — posts, replies, quotes
 *    and reposts with canonical post URLs, plus the same response carries the
 *    fresh profile so follower/bio tracking costs zero extra requests.
 *  - KEYLESS mode (no cookie): real profile monitoring via FixTweet's public
 *    API — follower-count and bio change detection with real profile links.
 * No simulator, no fabricated content — the radar only ever stores what X
 * actually returned.
 */

import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { fetchProfileKeyless } from "@/lib/fxtwitter";
import {
  fetchFollowingList,
  fetchTimelineGraphQL,
  fetchUserByScreenName,
  GqlError,
  isValidAuthToken,
  type SessionProfile,
  type SessionTweet,
  type XSession,
} from "@/lib/x-graphql";
import {
  buildFollowDigestAlert,
  buildRoutedAlert,
  mirrorTweetUrl,
  sendTelegramHtml,
  shouldPingTelegram,
  type AlertMetrics,
  type EventType,
  type FollowTargetInfo,
  type NotifyPrefs,
} from "@/lib/telegram";

export interface ScanResult {
  scanId: string;
  status: string;
  mode: string;
  accountsChecked: number;
  eventsFound: number;
  alertsSent: number;
  message?: string;
}

/**
 * Follower-count delta that turns into a PROFILE event + Telegram alert.
 * Scales with account size: small counts jitter constantly (±10 baseline),
 * while huge accounts gain/lose a dozen followers every minute — a fixed
 * threshold would flood the feed with noise. 0.05% of the current count,
 * floored at ±10, keeps swings meaningful at every scale.
 */
function followerThreshold(current: number): number {
  return Math.max(FOLLOWER_ALERT_THRESHOLD, Math.round(current * 0.0005));
}
const FOLLOWER_ALERT_THRESHOLD = 10;

/** Tiny stable hash for bio-change dedup keys. */
function hash32(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// Shared real-profile tracking (identity sync, follower swings, bio edits)
// ---------------------------------------------------------------------------

interface ProfileSnapshot {
  id?: string;
  screenName?: string;
  name?: string;
  description?: string;
  followers?: number;
  tweetCount?: number;
}

async function applyProfileTracking(
  account: {
    id: string;
    username: string;
    displayName: string | null;
    bio: string | null;
    externalId: string | null;
  },
  profile: ProfileSnapshot
): Promise<{ inserted: number; profileUrl: string }> {
  let inserted = 0;

  // Previous real values (followers come from the newest PROFILE event that
  // actually CARRIES a metrics snapshot — bio/name rows store metrics=null and
  // must never shadow the follower chain: reading prev from a metrics-less row
  // yields null, the code then tries to re-baseline with an already-used
  // "profile-baseline" externalId, the unique constraint silently rejects it,
  // and follower display freezes forever. Learned the hard way 2026-10-02.)
  const lastFollowerSnapshot = await db.activityEvent.findFirst({
    where: { accountId: account.id, type: "PROFILE", metrics: { not: null } },
    orderBy: { detectedAt: "desc" },
  });
  let prevFollowers: number | null = null;
  if (lastFollowerSnapshot?.metrics) {
    try {
      prevFollowers =
        (JSON.parse(lastFollowerSnapshot.metrics) as { followers?: number }).followers ?? null;
    } catch {
      prevFollowers = null;
    }
  }
  const oldBio = account.bio;
  const followers = profile.followers ?? null;

  // Sync real identity onto the watchlist row. followersCount is persisted on
  // EVERY sweep that sees a profile (not just alert-worthy deltas) so the
  // dashboard sidebar always has the newest real number — no extra requests.
  await db.watchedAccount.update({
    where: { id: account.id },
    data: {
      externalId: profile.id ?? account.externalId,
      displayName: profile.name ?? account.displayName,
      bio: profile.description || account.bio,
      lastScanAt: new Date(),
      ...(followers != null
        ? { followersCount: followers, followersAt: new Date() }
        : {}),
    },
  });

  const profileUrl = `https://x.com/${profile.screenName ?? account.username}`;
  const createProfileEvent = async (opts: {
    externalId: string;
    text: string;
    followers?: number;
  }) => {
    try {
      // PROFILE events (bio / name / follower-count changes) are DASHBOARD ONLY
      // per the notification scope — they never ping Telegram.
      await db.activityEvent.create({
        data: {
          accountId: account.id,
          type: "PROFILE",
          externalId: opts.externalId,
          text: opts.text,
          url: profileUrl,
          metrics: opts.followers != null ? JSON.stringify({ followers: opts.followers }) : null,
        },
      });
      inserted++;
    } catch {
      /* duplicate (unique accountId+externalId) — nothing new */
    }
  };

  // Date-scoped externalIds: a follower count can legitimately revisit an old
  // value (rise, drop, rise again) and a baseline can legitimately re-fire if
  // history was corrupted — a FIXED id would collide with the old event and
  // silently freeze the follower chain. Scoping by day keeps same-day dedup
  // (the delta gate fires at most once per change anyway) while never blocking
  // a legitimate correction.
  const dayKey = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  if (followers != null && prevFollowers == null) {
    // First real snapshot — stored silently as the audit baseline for future deltas
    const parts = [`${followers.toLocaleString()} followers`];
    if (profile.tweetCount != null) parts.push(`${profile.tweetCount.toLocaleString()} posts`);
    await createProfileEvent({
      externalId: `profile-baseline-${dayKey}`,
      text: `Real profile snapshot — ${parts.join(" · ")}`,
      followers,
    });
  } else if (followers != null && prevFollowers != null) {
    const delta = followers - prevFollowers;
    if (Math.abs(delta) >= followerThreshold(prevFollowers)) {
      await createProfileEvent({
        externalId: `profile-followers-${followers}-${dayKey}`,
        text: `Follower count changed: ${prevFollowers.toLocaleString()} → ${followers.toLocaleString()} (${delta >= 0 ? "+" : ""}${delta.toLocaleString()})`,
        followers,
      });
    }
  }

  // Bio edits are deliberate acts — surfaced on the dashboard (never Telegram).
  // Guarded on "a prior follower snapshot exists" so a brand-new account's
  // first sweep never mistakes its own bootstrap for an edit.
  const newBio = profile.description || "";
  if (lastFollowerSnapshot && oldBio && newBio && newBio !== oldBio) {
    await createProfileEvent({
      externalId: `profile-bio-${hash32(newBio)}`,
      text: `Bio updated: "${newBio.slice(0, 180)}"`,
    });
  }

  return { inserted, profileUrl };
}

// ---------------------------------------------------------------------------
// SESSION mode — real timeline monitoring via x.com web GraphQL (free)
// ---------------------------------------------------------------------------

function sessionFromSettings(s: { xAuthToken: string | null; xCt0: string | null }): XSession | null {
  // STRICT: a malformed / non-hex stored token must never put the radar into
  // session mode — every sweep would fail against X and the notes would read
  // "partial" forever. Fallback to keyless profile tracking instead (mirrors
  // settings.hasSession, which always used isValidAuthToken).
  if (!isValidAuthToken(s.xAuthToken)) return null;
  return { authToken: s.xAuthToken, ct0: s.xCt0 };
}

async function processSessionAccount(
  account: {
    id: string;
    username: string;
    displayName: string | null;
    bio: string | null;
    externalId: string | null;
    lastTweetId: string | null;
    followingSeeds: string | null;
    trackPosts: boolean;
    trackReposts: boolean;
    trackReplies: boolean;
    trackLikes: boolean;
    trackFollows: boolean;
  },
  session: XSession,
  prefs: NotifyPrefs
): Promise<{ events: number; alerts: number; notes: string[]; sessionInvalid: boolean }> {
  const notes: string[] = [];
  let inserted = 0;
  let alerts = 0;
  let sessionInvalid = false;

  // Resolve the numeric user id (needed for GraphQL) if we don't have it yet
  let userId = account.externalId;
  if (!userId) {
    try {
      const profile = await fetchUserByScreenName(account.username, session);
      userId = profile.id || null;
      if (!userId) throw new Error("empty rest_id");
      await db.watchedAccount.update({ where: { id: account.id }, data: { externalId: userId } });
      account.externalId = userId;
    } catch (err) {
      if (err instanceof GqlError && err.kind === "session_invalid") sessionInvalid = true;
      notes.push(`@${account.username}: user id lookup failed (${describeGqlError(err)})`);
      return { events: 0, alerts: 0, notes, sessionInvalid };
    }
  }

  let result: Awaited<ReturnType<typeof fetchTimelineGraphQL>> | null = null;
  try {
    result = await fetchTimelineGraphQL(userId, account.username, session);
  } catch (err) {
    // Timeline down ≠ follows down: fall through so the Following-tab diff
    // still runs this sweep — follow tracking is the top user priority and a
    // transient timeline error must never pause it for a cycle.
    if (err instanceof GqlError && err.kind === "session_invalid") sessionInvalid = true;
    notes.push(`@${account.username}: timeline fetch failed (${describeGqlError(err)})`);
  }

  // Profile tracking (follower swings, bio edits). X slimmed the timeline
  // response — the user core is no longer embedded — so pull a fresh snapshot
  // via UserByScreenName on the same session (one cheap extra call).
  // Identity guard: only sync when the response really belongs to this account,
  // so a mismatched payload can never overwrite the wrong watchlist row.
  let knownFollowingCount: number | null = null;
  if (result) {
    try {
      let u = result.user;
      if (!u) {
        u = await fetchUserByScreenName(account.username, session).catch(() => null);
      }
      const sameAccount =
        u &&
        (u.id === userId ||
          (u.screenName && u.screenName.toLowerCase() === account.username.toLowerCase()));
      if (u && sameAccount) {
        if (typeof u.following === "number") knownFollowingCount = u.following;
        const res = await applyProfileTracking(account, u);
        inserted += res.inserted;
      } else {
        await db.watchedAccount.update({
          where: { id: account.id },
          data: { lastScanAt: new Date() },
        });
      }
    } catch (err) {
      if (err instanceof GqlError && err.kind === "session_invalid") sessionInvalid = true;
      await db.watchedAccount.update({ where: { id: account.id }, data: { lastScanAt: new Date() } });
    }
  } else {
    // No timeline response — still touch lastScanAt so the dashboard shows a live sweep.
    await db.watchedAccount.update({ where: { id: account.id }, data: { lastScanAt: new Date() } });
  }

  // Timeline events — only tweets NEWER than the last watermark (lastKnownTweetId)
  const isFirstScan = !account.lastTweetId;
  const watermark = account.lastTweetId;
  let newest = watermark;

  // BOUNDED CATCH-UP: if page 1 came back FULL and every tweet on it is newer
  // than the watermark, the account posted faster than our sweep cadence (a
  // burst, or downtime while the server restarted) — items between the old
  // watermark and page 1's tail would be silently skipped forever. One extra
  // cursor page (best-effort) closes that gap; the unique accountId+externalId
  // constraint makes double-processing harmless.
  const pages: SessionTweet[] = result ? [...result.tweets] : [];
  if (result && !isFirstScan && watermark && result.nextCursor) {
    const fullPage = result.tweets.length >= 12;
    const allNewer = fullPage && result.tweets.every((t) => BigInt(t.id) > BigInt(watermark));
    if (allNewer) {
      try {
        const page2 = await fetchTimelineGraphQL(userId, account.username, session, result.nextCursor);
        for (const t of page2.tweets) {
          if (!pages.some((p) => p.id === t.id)) pages.push(t);
        }
      } catch {
        /* catch-up is best-effort — page 1 already covers the head */
      }
    }
  }

  for (const t of pages) {
    if (watermark && BigInt(t.id) <= BigInt(watermark)) continue;
    if (BigInt(t.id) > BigInt(newest ?? 0)) newest = t.id;

    if (!isTracked(account, t.type)) continue;
    const created = new Date(t.createdAt);
    try {
      await db.activityEvent.create({
        data: {
          accountId: account.id,
          type: t.type,
          externalId: t.id,
          text: t.text,
          url: t.url,
          metrics: JSON.stringify(t.metrics),
          // Bootstrap scan lands the account's current recent posts silently
          // (visible in the feed, no alert burst); later scans alert for real.
          notified: isFirstScan,
          detectedAt: created,
        },
      });
      inserted++;
      if (!isFirstScan) {
        // HIGH-SIGNAL ROUTING: the event always lands on the dashboard, but
        // Telegram is only pinged when the notification scope allows this type
        // (replies/reposts/profile stay dashboard-only by default).
        const ok = await deliverAlert(
          {
            type: t.type,
            text: t.text,
            url: t.url,
            targetUser: t.targetUser ?? null,
            metrics: t.metrics,
          },
          { username: account.username, displayName: account.displayName },
          prefs
        );
        if (ok) {
          alerts++;
          await db.activityEvent.update({
            where: { accountId_externalId: { accountId: account.id, externalId: t.id } },
            data: { notified: true },
          });
        }
      }
    } catch {
      /* duplicate (unique accountId+externalId) — already seen */
    }
  }

  await db.watchedAccount.update({
    where: { id: account.id },
    data: { lastTweetId: newest ?? account.lastTweetId },
  });

  // --- NEW FOLLOW DETECTION (Following-tab diff, one extra free call) ---
  // X orders the list most-recent-follow-first, so anything missing from the
  // stored baseline is a NEW follow. First run seeds the baseline silently.
  // An empty response is AMBIGUOUS (could be anti-bot throttling) — it never
  // overwrites a baseline, so a transient empty can never fake "unfollowed
  // everyone". The profile's own following count (when 0) is the one trusted
  // short-circuit: the account really follows nobody.
  if (account.trackFollows) {
    let seeds: string[] | null = null;
    if (account.followingSeeds) {
      try {
        const parsed = JSON.parse(account.followingSeeds);
        if (Array.isArray(parsed)) seeds = parsed.filter((x): x is string => typeof x === "string");
      } catch {
        seeds = null;
      }
    }

    if (knownFollowingCount === 0) {
      // Account follows nobody — mark the baseline seeded without any call
      if (seeds === null) {
        await db.watchedAccount.update({
          where: { id: account.id },
          data: { followingSeeds: JSON.stringify([]) },
        });
      }
    } else {
      const followBuffer: string[] = [];
      const followEventIds: string[] = [];
      try {
        const current = await fetchFollowingList(userId, session);
        if (current.length > 0) {
          if (seeds === null) {
            // Baseline sweep — remember who they already follow, alert nobody
            await db.watchedAccount.update({
              where: { id: account.id },
              data: { followingSeeds: JSON.stringify(current.map((f) => f.handle)) },
            });
          } else {
            const { fresh, merged } = diffFollowing(seeds, current.map((f) => f.handle));
            for (const handle of fresh) {
              try {
                const created = await db.activityEvent.create({
                  data: {
                    accountId: account.id,
                    type: "FOLLOW",
                    externalId: `follow-${handle}`,
                    text: `Started following @${handle}`,
                    url: `https://x.com/${handle}`,
                    targetUser: handle,
                  },
                });
                inserted++;
                followBuffer.push(handle);
                followEventIds.push(created.id);
              } catch {
                /* duplicate (unique accountId+externalId) — follow already recorded */
              }
            }
            await db.watchedAccount.update({
              where: { id: account.id },
              data: { followingSeeds: JSON.stringify(merged) },
            });

            // 🚨 Follow digest — ONE Telegram alert per sweep listing every new
            // account the target followed (only when the scope allows follows).
            if (followBuffer.length > 0) {
              const ok = await deliverFollowDigest(
                { username: account.username, displayName: account.displayName },
                followBuffer,
                prefs
              );
              if (ok) {
                alerts++;
                await db.activityEvent.updateMany({
                  where: { id: { in: followEventIds } },
                  data: { notified: true },
                });
              }
            }
          }
        }
        // current.length === 0 → ambiguous (throttled/protected) — keep the
        // previous baseline untouched and retry on the next sweep, silently.
      } catch (err) {
        if (err instanceof GqlError && err.kind === "session_invalid") sessionInvalid = true;
        notes.push(`@${account.username}: follow check failed (${describeGqlError(err)})`);
      }
    }
  }

  return { events: inserted, alerts, notes, sessionInvalid };
}

function describeGqlError(err: unknown): string {
  if (err instanceof GqlError) {
    switch (err.kind) {
      case "session_invalid":
        return "session cookies invalid or expired — re-copy auth_token/ct0 from a logged-in x.com tab";
      case "rate_limited":
        return "X rate limit reached for this session — will retry next sweep";
      case "forbidden":
        return `forbidden by X (${err.message})`;
      case "endpoint_gone":
        return "X moved the GraphQL endpoint — queryId fallback + self-heal exhausted";
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : "unknown error";
}

// ---------------------------------------------------------------------------
// KEYLESS mode — real profile monitoring via FixTweet (no cookies at all)
// ---------------------------------------------------------------------------

async function processKeylessAccount(account: {
  id: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  externalId: string | null;
}): Promise<{ events: number; alerts: number; notes: string[] }> {
  const notes: string[] = [];

  const profile = await fetchProfileKeyless(account.username);
  if (!profile.ok) {
    notes.push(`@${account.username}: real profile check failed (${profile.error ?? "unknown"})`);
    await db.watchedAccount.update({ where: { id: account.id }, data: { lastScanAt: new Date() } });
    return { events: 0, alerts: 0, notes };
  }

  const res = await applyProfileTracking(account, {
    id: profile.id,
    screenName: profile.screenName,
    name: profile.name,
    description: profile.description,
    followers: profile.followers,
    tweetCount: profile.tweetCount,
  });
  return { events: res.inserted, alerts: 0, notes };
}

// ---------------------------------------------------------------------------
// Alerting — high-signal routing
// ---------------------------------------------------------------------------

/**
 * Pure diff of the Following list against the stored baseline.
 * fresh  = handles X reports now that the baseline never saw → NEW follows
 * merged = updated baseline: current list first (recency order), then every
 *          handle ever seen (so an unfollow→refollow doesn't re-alert), capped.
 * Handles are normalized to lowercase with any leading @ stripped.
 */
export function diffFollowing(seeds: string[], current: string[]): { fresh: string[]; merged: string[] } {
  const norm = (h: string) => h.replace(/^@/, "").toLowerCase();
  const seedSet = new Set(seeds.map(norm));
  const fresh: string[] = [];
  const seen = new Set<string>();
  for (const handle of current) {
    const h = norm(handle);
    if (seen.has(h)) continue;
    seen.add(h);
    if (!seedSet.has(h)) fresh.push(h);
  }
  const merged: string[] = [];
  for (const h of [...current.map(norm), ...seeds.map(norm)]) {
    if (!merged.includes(h)) merged.push(h);
  }
  return { fresh, merged: merged.slice(0, 600) };
}

/** Exposed for tests: route + format + send a single event alert. */
export async function deliverAlert(
  event: {
    type: string;
    text: string | null;
    url: string | null;
    targetUser: string | null;
    metrics?: AlertMetrics | null;
  },
  account: { username: string; displayName?: string | null },
  prefs: NotifyPrefs
): Promise<boolean> {
  const s = await getSettings();
  if (!s.alertsEnabled || !s.telegramBotToken || !s.telegramChatId) return false;

  // STRICT ROUTING GATE — dashboard-only types (and toggled-off types) never
  // reach Telegram. The event itself still lives in the dashboard feed.
  // LINK stays the canonical x.com status URL (works in any logged-in
  // browser). PREVIEW is pinned to the login-free mirror (mirrorTweetUrl):
  // x.com serves Telegram's crawler an empty shell, while the mirror hands
  // over the full tweet card (text + photo) that unfurls inside the chat —
  // most alerts never need a tap at all. DB + dashboard keep x.com URLs.
  const html = buildRoutedAlert({
    type: event.type as EventType,
    username: account.username,
    displayName: account.displayName ?? null,
    text: event.text,
    url: event.url,
    targetUser: event.targetUser,
    metrics: event.metrics ?? null,
    prefs,
  });
  if (!html) return false;

  // Pin the link-preview card to the mirrored tweet URL — Telegram's crawler
  // gets the rich og-card from the mirror (tweet text + photo), so the post
  // renders inside the chat under the alert.
  const result = await sendTelegramHtml(s.telegramBotToken, s.telegramChatId, html, {
    previewUrl: mirrorTweetUrl(event.url),
  });
  return result.ok;
}

/** 🚨 One batched alert per sweep listing every new account the target followed. Exposed for tests. */
export async function deliverFollowDigest(
  account: { username: string; displayName?: string | null },
  targets: string[],
  prefs: NotifyPrefs
): Promise<boolean> {
  if (!shouldPingTelegram("FOLLOW", prefs)) return false;
  const s = await getSettings();
  if (!s.alertsEnabled || !s.telegramBotToken || !s.telegramChatId) return false;

  // Enrich every new follow with its REAL public profile (keyless FixTweet —
  // free, no cookies) so the digest shows WHO was followed: name, bio, reach.
  // Best-effort: a failed lookup degrades to a plain linked handle.
  const enriched = await enrichFollowTargets(targets);
  const html = buildFollowDigestAlert({
    username: account.username,
    displayName: account.displayName ?? null,
    targets: enriched,
  });
  const result = await sendTelegramHtml(s.telegramBotToken, s.telegramChatId, html);
  return result.ok;
}

/** Look up public profiles for a batch of handles, gently (5 at a time). */
async function enrichFollowTargets(handles: string[]): Promise<FollowTargetInfo[]> {
  const out: FollowTargetInfo[] = [];
  for (let i = 0; i < handles.length; i += 5) {
    const batch = handles.slice(i, i + 5);
    out.push(
      ...(await Promise.all(
        batch.map(async (handle): Promise<FollowTargetInfo> => {
          try {
            const p = await fetchProfileKeyless(handle);
            if (p.ok) {
              return { handle, name: p.name ?? null, bio: p.description || null, followers: p.followers ?? null };
            }
          } catch {
            /* enrichment is best-effort — bare handle still alerts */
          }
          return { handle };
        })
      ))
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-account processing
// ---------------------------------------------------------------------------

const ALL_TYPES: EventType[] = ["POST", "REPOST", "REPLY", "QUOTE", "LIKE", "FOLLOW"];

function isTracked(account: {
  trackPosts: boolean; trackReposts: boolean; trackReplies: boolean;
  trackLikes: boolean; trackFollows: boolean;
}, type: EventType): boolean {
  switch (type) {
    case "POST": case "QUOTE": return account.trackPosts;
    case "REPOST": return account.trackReposts;
    case "REPLY": return account.trackReplies;
    case "LIKE": return account.trackLikes;
    case "FOLLOW": return account.trackFollows;
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// Session-death warning — never let the radar die silently
// ---------------------------------------------------------------------------

const SESSION_WARN_TTL_MS = 6 * 60 * 60 * 1000; // one ping per 6h while dead
const globalForSessionWarn = globalThis as unknown as { __trSessionWarnAt?: number };

/**
 * Ping the operator's Telegram chat when X starts rejecting the burner
 * session. Without this, expired cookies look like "nothing happened" — the
 * dashboard shows partial sweeps but the person depending on the alerts has
 * no idea monitoring went dark. Throttled so a dead session doesn't spam.
 */
async function warnSessionDead(): Promise<void> {
  const last = globalForSessionWarn.__trSessionWarnAt ?? 0;
  if (Date.now() - last < SESSION_WARN_TTL_MS) return;
  globalForSessionWarn.__trSessionWarnAt = Date.now();
  try {
    const s = await getSettings();
    if (!s.alertsEnabled || !s.telegramBotToken || !s.telegramChatId) return;
    const html =
      "🍪 <b>TWEETRADAR</b> — <b>X SESSION EXPIRED</b>\n\n" +
      "X rejected the burner session cookies, so timeline tracking (posts, replies, follows) is paused.\n\n" +
      "Re-copy <b>auth_token</b> (+ ct0) from a logged-in x.com tab and paste them in Settings → X session.\n\n" +
      "Meanwhile the radar keeps running in profile-only mode: follower swings and bio edits still land on the dashboard.";
    await sendTelegramHtml(s.telegramBotToken, s.telegramChatId, html);
  } catch {
    /* best-effort — the scan notes already record the session state */
  }
}

// ---------------------------------------------------------------------------
// Full scan cycle
// ---------------------------------------------------------------------------

let scanning = false;

export function isScanning(): boolean {
  return scanning;
}

export async function runScan(
  trigger: "auto" | "manual" = "auto",
  onlyAccountId?: string
): Promise<ScanResult> {
  if (scanning) {
    const last = await db.scanLog.findFirst({ where: { status: "running" } });
    return {
      scanId: last?.id ?? "busy", status: "skipped", mode: "-", accountsChecked: 0,
      eventsFound: 0, alertsSent: 0, message: "A scan is already in progress",
    };
  }
  scanning = true;

  const settings = await getSettings();
  const session = sessionFromSettings(settings);
  const mode = session ? "session" : "keyless";

  const log = await db.scanLog.create({ data: { status: "running", trigger, mode } });
  // Per-account sweep (sidebar "Sweep" button) filters the cycle to ONE row;
  // full sweeps iterate every active account as before.
  const accounts = await db.watchedAccount.findMany({
    where: onlyAccountId ? { id: onlyAccountId } : { active: true },
  });

  let eventsFound = 0;
  let alertsSent = 0;
  const notes: string[] = [];
  // Accounts whose processing hit X "session_invalid" — they got nothing this
  // sweep and need the keyless fallback below.
  const sessionDeadAccounts: typeof accounts = [];

  try {
    for (const account of accounts) {
      if (session) {
        const res = await processSessionAccount(account, session, settings);
        eventsFound += res.events;
        alertsSent += res.alerts;
        notes.push(...res.notes);
        if (res.sessionInvalid) sessionDeadAccounts.push(account);
      } else {
        const res = await processKeylessAccount(account);
        eventsFound += res.events;
        alertsSent += res.alerts;
        notes.push(...res.notes);
      }
    }

    // SESSION-DEATH HANDLING — X rejected the burner cookies. Timeline reads
    // are dead, but follower/bio tracking can still run through the FREE
    // keyless path (FixTweet), and the operator must be told to re-paste
    // cookies instead of the radar failing silently forever.
    if (session && sessionDeadAccounts.length > 0) {
      notes.push(
        `X session rejected for ${sessionDeadAccounts.length} account(s) — keyless profile fallback applied`
      );
      for (const account of sessionDeadAccounts) {
        try {
          const res = await processKeylessAccount(account);
          eventsFound += res.events;
        } catch {
          /* best-effort — the session note above already flags the state */
        }
      }
      await warnSessionDead();
    }

    const status = notes.length > 0 ? "partial" : "success";
    await db.scanLog.update({
      where: { id: log.id },
      data: {
        finishedAt: new Date(),
        status,
        accountsChecked: accounts.length,
        eventsFound,
        alertsSent,
        message: notes.length ? notes.join(" | ").slice(0, 500) : null,
      },
    });
    return { scanId: log.id, status, mode, accountsChecked: accounts.length, eventsFound, alertsSent, message: notes.join(" | ") || undefined };
  } catch (err) {
    await db.scanLog.update({
      where: { id: log.id },
      data: {
        finishedAt: new Date(),
        status: "error",
        accountsChecked: accounts.length,
        eventsFound,
        message: (err instanceof Error ? err.message : "Unknown error").slice(0, 500),
      },
    });
    throw err;
  } finally {
    scanning = false;
  }
}

/** Exposed for the session-verify API route. */
export function resolveSession(settings: { xAuthToken: string | null; xCt0: string | null }): XSession | null {
  return sessionFromSettings(settings);
}

export type { SessionProfile };
