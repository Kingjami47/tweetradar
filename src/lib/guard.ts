/**
 * Channel Guard — 24/7 anti-link enforcement for the owner's Telegram
 * group/channel, powered by the same bot + getUpdates poller as the radar
 * (zero new infrastructure, zero cost).
 *
 * Policy (per the owner's brief — "ban any links dropped by members, from
 * those I know and those I don't"):
 *   · ANY link in ANY message (text or media caption) from ANY member is a
 *     violation — no allowlist loopholes, no matter who they are.
 *   · Action: delete the message + ban the sender (Telegram banChatMember).
 *   · The OWNER (the bot's alert chat) is always exempt — it is their channel.
 *   · PRIVILEGED IDENTITIES are never banned — not even in strict mode:
 *       - auto-forwarded channel posts landing in the linked discussion group
 *         (sender_chat = the channel, is_automatic_forward, from = 777000)
 *       - anonymous admin posts (from = GroupAnonymousBot, sender_chat = group)
 *       - messages sent "as the channel" (sender_chat = a channel)
 *       - Telegram's own service account (777000)
 *     Members cannot forge any of these — Telegram sets sender_chat only for
 *     privileged senders, so the check is unspoofable. (Seen live: the owner's
 *     channel broadcast auto-forwarded into the discussion group got
 *     deleted+banned against user 777000 — a pure false positive.)
 *   · Other ADMINS (real, direct sends) are exempt by default; /guard strict
 *     removes that exemption so admins are banned like everyone else.
 *   · Every action is logged to GuardLog and reported to the owner's chat.
 *
 * Link detection uses Telegram's OWN entity parsing (entities/caption_entities
 * of type url/text_link) plus a regex net for raw http(s)/www links typed
 * without autolink formatting — so obfuscated "paste the link as plain text"
 * spam still gets caught.
 */

import { db } from "@/lib/db";
import { escapeHtml as esc, sendTelegramHtml } from "@/lib/telegram";
import type { AppSettings } from "@/lib/settings";

// ---------------------------------------------------------------------------
// Telegram update shapes (guard-relevant subset)
// ---------------------------------------------------------------------------

export interface TgEntity {
  type: string;
  url?: string;
  offset: number;
  length: number;
}

export interface GuardMsg {
  message_id?: number;
  from?: { id: number; is_bot?: boolean; username?: string; first_name?: string };
  sender_chat?: { id: number; title?: string };
  is_automatic_forward?: boolean;
  text?: string;
  caption?: string;
  entities?: TgEntity[];
  caption_entities?: TgEntity[];
}

// ---------------------------------------------------------------------------
// Link detection (pure — unit-tested)
// ---------------------------------------------------------------------------

/**
 * Raw-link regex net: catches links Telegram did NOT autolink —
 * "check https://scam.io", "go to www.freecrypto.xyz", plus scheme-less
 * paths on domains every client autolinks anyway (t.me/…, x.com/…).
 * Bare domains ("telegram dot me", "freecrypto (dot) com", "google.com")
 * are intentionally NOT matched — too many false positives on normal chatter.
 */
const RAW_LINK_RE =
  /https?:\/\/\S+|www\.\S+|\b(?:t\.me|telegram\.me|telegram\.dog|x\.com|twitter\.com)\/\S+/i;

export function detectLink(
  text: string | undefined,
  caption: string | undefined,
  entities: TgEntity[] | undefined,
  captionEntities: TgEntity[] | undefined
): boolean {
  // 1. Telegram's own parser — the authoritative signal. "url" = autolinked
  //    plain URL, "text_link" = hyperlinked text ("join here" → t.me/…).
  for (const list of [entities, captionEntities]) {
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (e?.type === "url" || e?.type === "text_link") return true;
    }
  }
  // 2. Regex net over the visible text (covers unlinked raw URLs that the
  //    entity stream somehow missed — e.g. edited messages).
  const visible = `${text ?? ""}\n${caption ?? ""}`;
  return RAW_LINK_RE.test(visible);
}

/** First 100 chars of the offending message, newline-flattened, for logs. */
function snippet(text: string | undefined, caption: string | undefined): string {
  return `${text ?? caption ?? ""}`.replace(/\s+/g, " ").trim().slice(0, 100);
}

/** Telegram's fixed service-account id — "from" of auto-forwarded channel posts. */
export const TELEGRAM_SERVICE_ID = 777_000;

/** Telegram's fixed id for GroupAnonymousBot — "from" of every anonymous-admin post. */
export const GROUP_ANONYMOUS_BOT_ID = 1_087_968_824;

/**
 * Pure: is this message from a PRIVILEGED identity rather than a direct
 * member send? Returns the exemption label, or null for an ordinary member.
 *
 *   · sender_chat present  → Telegram sets it ONLY for privileged senders:
 *       - linked-channel auto-forward into the discussion group
 *         (the owner's channel broadcast — must never be touched)
 *       - anonymous admin post (from = GroupAnonymousBot, sender_chat = group)
 *       - "sent as channel" post (sender_chat = that channel)
 *   · from = 777000        → Telegram's own service account
 *
 * A regular member can never produce any of these shapes, so the check is
 * unspoofable. Strict mode deliberately does NOT override it — the owner's
 * brief: "anonymous admins like me or other admins never get banned; only
 * direct member sends are enforced".
 */
export function privilegedSenderDetail(msg: GuardMsg): string | null {
  if (msg.sender_chat) {
    if (msg.is_automatic_forward) return "linked-channel auto-forward";
    if (msg.from?.id === GROUP_ANONYMOUS_BOT_ID) return "anonymous admin post";
    return "channel identity post";
  }
  if (msg.from?.id === TELEGRAM_SERVICE_ID) return "telegram service account";
  return null;
}

// ---------------------------------------------------------------------------
// Telegram Bot API helpers (plain fetch — same free surface as the rest)
// ---------------------------------------------------------------------------

type TgCallResult<T> = { ok: boolean; result?: T; error?: string; retryAfter?: number };

async function tgCall<T>(
  botToken: string,
  method: string,
  params: Record<string, unknown>
): Promise<TgCallResult<T>> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } }
      | null;
    if (!res.ok || !data?.ok) {
      return {
        ok: false,
        error: data?.description || `HTTP ${res.status}`,
        retryAfter: data?.parameters?.retry_after,
      };
    }
    return { ok: true, result: data.result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

/**
 * tgCall with ONE bounded retry on TRANSIENT failures only — network errors,
 * HTTP 5xx and 429 (honouring Telegram's retry_after, capped at 5s so the
 * poller never wedges). Permanent rejections (rights, not-found, malformed)
 * return immediately: retrying those would just burn time, never succeed.
 * This is what makes delete+ban stick even through Telegram-side hiccups.
 */
async function tgCallRetry<T>(
  botToken: string,
  method: string,
  params: Record<string, unknown>
): Promise<TgCallResult<T>> {
  const first = await tgCall<T>(botToken, method, params);
  if (first.ok) return first;
  const transient =
    first.error === "Network error" ||
    /^HTTP 5/.test(first.error ?? "") ||
    first.error === "Too Many Requests" ||
    /^HTTP 429$/.test(first.error ?? "");
  if (!transient) return first;
  const waitSec = Math.min(first.retryAfter ?? 1, 5);
  await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
  return tgCall<T>(botToken, method, params);
}

let cachedBotId: number | null = null;

/** Resolve (and cache) the bot's own user id so it never bans itself. */
export async function getBotId(botToken: string): Promise<number | null> {
  if (cachedBotId !== null) return cachedBotId;
  const r = await tgCall<{ id: number }>(botToken, "getMe", {});
  if (r.ok && typeof r.result?.id === "number") {
    cachedBotId = r.result.id;
    return cachedBotId;
  }
  return null;
}

/**
 * Raw membership status of a user in a chat: "creator" | "administrator" | "member" | "restricted" | "left" | "kicked".
 * Uses the retrying caller — two consecutive failures are needed before a
 * status becomes unknowable. Returns null on hard failure.
 */
export async function getChatMemberStatus(
  botToken: string,
  chatId: string,
  userId: number
): Promise<string | null> {
  const r = await tgCallRetry<{ status?: string }>(botToken, "getChatMember", {
    chat_id: chatId,
    user_id: userId,
  });
  return r.ok ? (r.result?.status ?? null) : null;
}

/**
 * Admin exemption check. NOTE the failure stance: if the status is
 * unknowable after retries, the sender is treated as NOT admin — the owner's
 * priority is that direct member sends are ENFORCED ("make sure the
 * delete/ban does it very well"), and privileged identities are already
 * exempted by unspoofable fields before this check ever runs.
 */
async function isChatAdmin(
  botToken: string,
  chatId: string,
  userId: number
): Promise<boolean> {
  const status = await getChatMemberStatus(botToken, chatId, userId);
  return status === "administrator" || status === "creator";
}

/** What the bot itself may do in a chat — used for /guard arming feedback. */
export async function getBotRights(
  botToken: string,
  chatId: string
): Promise<{ isAdmin: boolean; canDelete: boolean; canRestrict: boolean }> {
  const r = await tgCall<{
    status?: string;
    can_delete_messages?: boolean;
    can_restrict_members?: boolean;
  }>(botToken, "getChatMember", { chat_id: chatId, user_id: await getBotId(botToken) });
  if (!r.ok || !r.result) return { isAdmin: false, canDelete: false, canRestrict: false };
  return {
    isAdmin: r.result.status === "administrator",
    canDelete: Boolean(r.result.can_delete_messages),
    canRestrict: Boolean(r.result.can_restrict_members),
  };
}

// ---------------------------------------------------------------------------
// The guard itself
// ---------------------------------------------------------------------------

export interface GuardOutcome {
  /** ignored | exempt | clean | deleted | deleted+banned | banned | failed */
  action: string;
  detail?: string;
}

/**
 * Enforce the link policy on one message from the guarded chat.
 * Never throws — a guard failure must never wedge the poller loop.
 * opts.suppressReport: skip the owner DM (used by the /guard self-test, which
 * reports its own consolidated results instead).
 */
export async function handleGuardMessage(
  msg: GuardMsg,
  settings: AppSettings,
  chatTitle?: string,
  opts?: { suppressReport?: boolean }
): Promise<GuardOutcome> {
  const botToken = settings.telegramBotToken;
  const chatId = settings.guardChatId;
  if (!botToken || !chatId) return { action: "ignored", detail: "guard not configured" };
  if (!settings.guardEnabled) return { action: "ignored", detail: "guard paused" };

  const sender = msg.from;
  const senderId = sender?.id;

  // Never act on the bot's own messages (its /guard confirmations etc.).
  if (senderId && senderId === (await getBotId(botToken))) {
    return { action: "ignored", detail: "bot's own message" };
  }

  const text = msg.text ?? msg.caption;
  if (!detectLink(msg.text, msg.caption, msg.entities, msg.caption_entities)) {
    return { action: "clean" };
  }

  // PRIVILEGED IDENTITIES — never enforced, not even in strict mode. Checked
  // AFTER link detection so clean chatter still takes the no-log path.
  const privileged = privilegedSenderDetail(msg);
  if (privileged) {
    await logGuard(chatId, chatTitle, sender, "exempt", privileged, text, msg.message_id);
    return { action: "exempt", detail: privileged };
  }

  const who = sender?.username
    ? `@${sender.username}`
    : sender?.first_name
      ? sender.first_name
      : "unknown sender";

  // Owner is ALWAYS exempt — it is their channel.
  const ownerId = Number(settings.telegramChatId);
  if (senderId && Number.isFinite(ownerId) && senderId === ownerId) {
    await logGuard(chatId, chatTitle, sender, "exempt", "owner", text, msg.message_id);
    return { action: "exempt", detail: "owner" };
  }

  // Admins exempt unless strict mode.
  if (!settings.guardStrict && senderId && (await isChatAdmin(botToken, chatId, senderId))) {
    await logGuard(chatId, chatTitle, sender, "exempt", "admin", text, msg.message_id);
    return { action: "exempt", detail: "admin" };
  }

  // DELETE the offending message first — even if the ban fails, the link dies.
  const del = await tgCallRetry(botToken, "deleteMessage", {
    chat_id: chatId,
    message_id: msg.message_id,
  });

  // BAN the sender.
  let banError: string | null = null;
  if (senderId) {
    const ban = await tgCallRetry(botToken, "banChatMember", {
      chat_id: chatId,
      user_id: senderId,
    });
    if (!ban.ok) banError = ban.error ?? "ban failed";
  } else {
    // Anonymous channel/admin post — no user id to ban; deletion still applies.
    banError = "no sender id (anonymous post) — deleted only";
  }

  const action =
    del.ok && !banError
      ? "deleted+banned"
      : del.ok
        ? "deleted"
        : !banError
          ? "banned"
          : "failed";
  const detail = [
    del.ok ? null : `delete failed: ${del.error}`,
    banError,
  ]
    .filter(Boolean)
    .join("; ");

  await logGuard(chatId, chatTitle, sender, action, detail || null, text, msg.message_id);
  if (!opts?.suppressReport) {
    await notifyOwner(settings, chatId, chatTitle, who, action, detail, snippet(msg.text, msg.caption));
  }
  return { action, detail: detail || undefined };
}

async function logGuard(
  chatId: string,
  chatTitle: string | undefined,
  sender: GuardMsg["from"],
  action: string,
  detail: string | null,
  text: string | undefined,
  messageId?: number
): Promise<void> {
  try {
    await db.guardLog.create({
      data: {
        chatId,
        chatTitle: chatTitle ?? null,
        userId: sender?.id != null ? String(sender.id) : null,
        username: sender?.username ?? null,
        firstName: sender?.first_name ?? null,
        action,
        detail,
        text: text ? snippet(text, undefined) : null,
        messageId: String(messageId),
      },
    });
  } catch (err) {
    console.error(
      "[TweetRadar] guard log write failed:",
      err instanceof Error ? err.message : err
    );
  }
}

async function notifyOwner(
  settings: AppSettings,
  chatId: string,
  chatTitle: string | undefined,
  who: string,
  action: string,
  detail: string | null,
  textSnippet: string
): Promise<void> {
  if (!settings.telegramBotToken || !settings.telegramChatId) return;
  const verdict =
    action === "deleted+banned"
      ? "🛡 <b>LINK GUARD</b> — message deleted, member banned"
      : action === "deleted"
        ? "🛡 <b>LINK GUARD</b> — message deleted (ban not applied)"
        : action === "banned"
          ? "🛡 <b>LINK GUARD</b> — member banned (delete failed)"
          : "⚠️ <b>LINK GUARD</b> — enforcement FAILED";
  const lines = [
    verdict,
    "",
    `👤 ${esc(who)} in <b>${esc(chatTitle ?? chatId)}</b>`,
  ];
  if (textSnippet) lines.push(`💬 ${esc(textSnippet)}`);
  if (detail) lines.push(`⚠️ ${esc(detail)}`);
  await sendTelegramHtml(settings.telegramBotToken, settings.telegramChatId, lines.join("\n"));
}
