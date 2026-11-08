/**
 * Shared watchlist-account creation — used by the dashboard API, the bulk API
 * and the Telegram bot's "+ @username" commands.
 *
 * Every handle is validated against real keyless X data (FixTweet) before it
 * lands on the watchlist: typos/nonexistent handles are rejected instantly and
 * real identity (display name, bio, user id) is seeded onto the row.
 */

import { db } from "@/lib/db";
import { fetchProfileKeyless } from "@/lib/fxtwitter";

export const USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;

const AVATAR_COLORS = ["#10b981", "#f59e0b", "#f43f5e", "#a855f7", "#06b6d4", "#f97316", "#84cc16", "#ec4899"];

export function titleCase(username: string): string {
  return username
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export interface AddAccountOutcome {
  input: string; // handle as the user typed it (no @)
  ok: boolean;
  username?: string; // canonical screen name of the created/tracked account
  alreadyTracked?: boolean;
  error?: string; // user-facing reason when ok === false
  errorKind?: "invalid" | "not_found" | "rate_limited" | "network" | "conflict";
  accountId?: string;
}

export interface TrackOverrides {
  trackPosts?: boolean;
  trackReplies?: boolean;
  trackReposts?: boolean;
  trackLikes?: boolean;
  trackFollows?: boolean;
}

/** Normalize a user-supplied handle: strip @, trim. Does not validate. */
export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@/, "").trim();
}

/**
 * Command words that must never become watchlist handles. People naturally
 * write "add @a\nadd @b" or "/add @a /add @b" — without this guard the word
 * "add" itself would be tracked as if it were @add.
 */
const COMMAND_WORDS = new Set([
  "add", "remove", "delete", "list", "help", "start", "stop", "watch",
]);

/**
 * Split a pasted/typed handle list into candidate handles, tolerating the
 * formats people ACTUALLY use (the "+@user one-per-line" style above all):
 *
 *   +@a            +@a            add @a          1. @a
 *   +@b            + @b, +@c      add @b          2. @b
 *   +@c
 *
 * Each token is cleaned at the EDGES only: glued signs / @ / slash prefixes
 * ("+@", "-@", "/@") and trailing punctuation/quotes are stripped; a handle's
 * legal alphabet is [A-Za-z0-9_], so nothing legitimate can be lost. Command
 * words and empties are dropped; anything else survives for the caller to
 * validate with USERNAME_RE (so bad entries can still be reported, not
 * silently swallowed).
 */
export function tokenizeHandleList(raw: string): string[] {
  return (raw || "")
    .split(/[\s,;]+/)
    .map((tok) =>
      tok
        .replace(/^[+➕➖\-/@]+/, "") // glued "+@x" / "-x" / "/add" prefixes
        .replace(/[.,;:!?)\]}"'»…]+$/, "") // trailing punctuation & quotes
        .trim()
    )
    .filter(
      (tok) =>
        tok.length > 0 &&
        !COMMAND_WORDS.has(tok.toLowerCase()) &&
        !/^\d+$/.test(tok) // "1." "2." list numbering — never a real handle paste
    );
}

export async function addWatchedAccount(
  raw: string,
  opts: { tracks?: TrackOverrides; notes?: string } = {}
): Promise<AddAccountOutcome> {
  const input = normalizeHandle(raw);
  if (!input) {
    return { input, ok: false, error: "Username is required", errorKind: "invalid" };
  }
  if (!USERNAME_RE.test(input)) {
    return {
      input,
      ok: false,
      error: "Invalid X/Twitter handle — use 1–15 letters, numbers or underscores",
      errorKind: "invalid",
    };
  }

  // X handles are case-insensitive — match existing rows on lowercase
  const all = await db.watchedAccount.findMany({ select: { id: true, username: true } });
  const existing = all.find((a) => a.username.toLowerCase() === input.toLowerCase());
  if (existing) {
    return {
      input,
      ok: true,
      username: existing.username,
      alreadyTracked: true,
      accountId: existing.id,
    };
  }

  // Validate the handle against real X data (keyless) and seed real identity.
  const profile = await fetchProfileKeyless(input);
  if (!profile.ok) {
    if (profile.errorKind === "not_found") {
      return { input, ok: false, username: undefined, error: `@${input} does not exist on X`, errorKind: "not_found" };
    }
    if (profile.errorKind === "rate_limited") {
      return {
        input,
        ok: false,
        error: `@${input} could not be verified right now (verification source rate-limited) — try again in a moment`,
        errorKind: "rate_limited",
      };
    }
    return {
      input,
      ok: false,
      error: `Could not verify @${input} on X (${profile.error ?? "unknown error"})`,
      errorKind: "network",
    };
  }

  // The findMany check above leaves a small race window (two simultaneous
  // adds of the same handle — e.g. Telegram + dashboard at once). The unique
  // constraint on username arbitrates: the loser must surface as
  // "already tracked", not crash the whole request with a raw P2002.
  try {
    const account = await db.watchedAccount.create({
      data: {
        username: profile.screenName || input,
        displayName: profile.name || titleCase(input),
        externalId: profile.id ?? null,
        bio: profile.description || null,
        avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
        trackPosts: opts.tracks?.trackPosts ?? true,
        trackReplies: opts.tracks?.trackReplies ?? true,
        trackReposts: opts.tracks?.trackReposts ?? true,
        trackLikes: opts.tracks?.trackLikes ?? false,
        trackFollows: opts.tracks?.trackFollows ?? true,
        notes: opts.notes?.slice(0, 300) || null,
      },
    });
    return { input, ok: true, username: account.username, accountId: account.id };
  } catch (err) {
    if ((err as { code?: string })?.code !== "P2002") throw err;
    const all = await db.watchedAccount.findMany({ select: { id: true, username: true } });
    const row = all.find((a) => a.username.toLowerCase() === input.toLowerCase());
    if (!row) throw err;
    return {
      input,
      ok: true,
      username: row.username,
      alreadyTracked: true,
      accountId: row.id,
    };
  }
}

/**
 * Add many handles with bounded concurrency (keeps the FixTweet validation
 * polite for bulk adds of 10–25 handles). Duplicates within the batch are
 * collapsed (first occurrence wins).
 */
export async function addWatchedAccounts(
  raws: string[],
  opts: { tracks?: TrackOverrides; notes?: string; concurrency?: number } = {}
): Promise<AddAccountOutcome[]> {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of raws) {
    const h = normalizeHandle(raw);
    if (!h) continue;
    const key = h.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(h);
  }

  const results: AddAccountOutcome[] = new Array(unique.length);
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 5, 10));
  let cursor = 0;
  async function worker() {
    while (cursor < unique.length) {
      const idx = cursor++;
      results[idx] = await addWatchedAccount(unique[idx], opts);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker));
  return results;
}
