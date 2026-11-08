/**
 * Two-way Telegram bot — the radar listens to ITS OWN chat.
 *
 * Users add watched accounts straight from Telegram (no dashboard needed):
 *   ➕  + @username          — watch an account
 *   📦  + @u1 @u2 ... @u25   — bulk add in one message
 *      (also: "add @username", "/add @u1 @u2")
 *   ➖  - @username          — stop watching
 *   📡  /list                — see the watchlist
 *   ❓  /help, /start        — command menu
 *
 * Every account added from Telegram gets the full dashboard treatment: the
 * scan engine picks it up on the next sweep, replies/reposts/likes/profile
 * edits land in the feed, and new follows + posts ping the chat per the
 * notification scope. The first chat to message the bot auto-claims the alert
 * target (Settings → Chat ID), so pasting the token is the only setup step.
 *
 * Delivery uses plain getUpdates short-polling (offset cursor persisted in
 * Settings) — no webhook, no public URL, 100% free.
 *
 * ANONYMITY LOCK (owner requirement — "mustn't work for others"):
 *   · The PUBLIC command menu is wiped from every scope; the full menu is
 *     scoped to the owner's private chat ONLY. A stranger opening the bot
 *     sees zero commands and a blank description — nothing reveals what it
 *     does.
 *   · Strangers who message the bot get TOTAL SILENCE — no reply, no error,
 *     no acknowledgement that their message was understood.
 *   · Guard confirmations/reports go to the owner's private chat only; the
 *     bot never posts anything in the guarded group/channel, and the
 *     owner's own /guard command message is wiped from that chat.
 *   · Only a private chat may claim the alert target — groups/channels
 *     can never claim it by being added.
 */

import { db } from "@/lib/db";
import { getSettings, saveSettings } from "@/lib/settings";
import { addWatchedAccounts, normalizeHandle, tokenizeHandleList } from "@/lib/accounts";
import { escapeHtml as esc, formatFollowers, sendTelegramHtml } from "@/lib/telegram";
import { runScan } from "@/lib/monitor";
import { fetchProfileKeyless } from "@/lib/fxtwitter";
import {
  handleGuardMessage,
  getBotRights,
  getChatMemberStatus,
  GROUP_ANONYMOUS_BOT_ID,
  type TgEntity,
} from "@/lib/guard";

const POLL_MS = 5_000;
const MAX_HANDLES = 25;

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

export interface ParsedCommand {
  kind: "add" | "remove" | "list" | "help" | "guard" | "unguard" | "unknown";
  handles: string[];
}

/**
 * Candidate handles from free-form text. Delegates to the shared tokenizer
 * (accounts.ts) which strips glued "+@user" / "-@user" prefixes, trailing
 * punctuation and command words — so ALL of these work as bulk input:
 *   + @a @b @c          +@a          add @a
 *   +@b (one per line)  + @b, + @c   add @b (one per line)
 * Invalid tokens are dropped silently here: the bot chat tolerates chatter,
 * while the dashboard's bulk API reports invalid entries back instead.
 */
function extractHandles(s: string): string[] {
  return tokenizeHandleList(s).filter((tok) => /^[A-Za-z0-9_]{1,15}$/.test(tok));
}

/**
 * Parse a Telegram message into a bot command.
 * Accepted add forms: "+ @a", "+@a", "+ a b c", "add @a @b", "/add @a",
 * "➕ @a". Bare "@a" (single token) also adds — the least-surprise path.
 */
export function parseCommand(rawText: string): ParsedCommand {
  const text = (rawText || "").trim();
  if (!text) return { kind: "unknown", handles: [] };

  // "/cmd@BotName" → "/cmd" (Telegram allows addressing a specific bot)
  const t = text.replace(/^\/([a-z]+)@[A-Za-z0-9_]+/i, "/$1");
  const lower = t.toLowerCase();

  if (lower === "/start" || lower === "/help" || lower === "help" || lower === "start") {
    return { kind: "help", handles: [] };
  }
  if (lower === "/list" || lower === "list") {
    return { kind: "list", handles: [] };
  }

  const addMatch = t.match(/^(?:\+|➕|\/add|add)\s*([\s\S]*)$/i);
  if (addMatch) return { kind: "add", handles: extractHandles(addMatch[1]) };

  const removeMatch = t.match(/^(?:-|➖|\/remove|\/delete|remove)\s*([\s\S]*)$/i);
  if (removeMatch) return { kind: "remove", handles: extractHandles(removeMatch[1]) };

  // Bare "@handle" → add it (single token only, so chatter never triggers adds)
  if (/^@[A-Za-z0-9_]{1,15}$/.test(t)) return { kind: "add", handles: [t.slice(1)] };

  // Channel Guard — /guard [strict|status|test], /unguard. The @BotName suffix
  // may trail the command OR the subcommand word ("/guard test@Bot" in groups).
  const guardMatch = t.match(/^\/guard(?:@[A-Za-z0-9_]+)?(?:\s+(strict|status|test)(?:@[A-Za-z0-9_]+)?)?(\s|$)/i);
  if (guardMatch) return { kind: "guard", handles: [guardMatch[1]?.toLowerCase() ?? ""] };
  if (/^\/unguard(?:@[A-Za-z0-9_]+)?$/i.test(t)) return { kind: "unguard", handles: [] };

  return { kind: "unknown", handles: [] };
}

// ---------------------------------------------------------------------------
// Reply builders (HTML)
// ---------------------------------------------------------------------------

function buildHelpHtml(): string {
  return (
    "🤖 <b>TweetRadar — bot commands</b>\n\n" +
    "➕ <code>+ @username</code> — watch an account\n" +
    "📦 <code>+ @u1 @u2 @u3 …</code> — bulk add up to 25\n" +
    "    (also works: one per line —\n" +
    "    <code>+@u1\n    +@u2\n    +@u3</code>)\n" +
    "    (also: <code>add @username</code>)\n" +
    "➖ <code>- @username</code> — stop watching\n" +
    "📡 <code>/list</code> — see the watchlist\n" +
    "🛡 <code>/guard</code> — arm link guard (send it in the group/channel)\n" +
    "🛡 <code>/guard strict</code> — also ban admins who drop links\n" +
    "🛡 <code>/guard status</code> · <code>/unguard</code> — check / disarm\n" +
    "🧪 <code>/guard test</code> — fire a live self-test of delete + ban\n" +
    "❓ <code>/help</code> — this menu\n\n" +
    "🔔 New <b>follows</b> &amp; <b>posts</b> ping this chat the moment they happen.\n" +
    "🖥 The dashboard keeps the full stream — replies, reposts, likes, profile edits — with links to every tweet.\n\n" +
    "🛡 <b>Link Guard</b>: add the bot to your channel/group as <b>admin</b> — allow <i>Delete messages</i> (+ <i>Ban users</i> for groups; channels only need Delete) — then send <code>/guard</code> in there.\n" +
    "Any link dropped by any member: message deleted + member banned, <b>silently</b> — the bot never posts in the guarded chat, and every report lands in THIS private chat.\n\n" +
    "🔒 <b>Private by design</b>: this bot answers to you alone. Strangers who open it get silence — no reply, no visible command menu, no description. Anything sent by anyone else is ignored."
  );
}

function buildAddHintHtml(): string {
  return (
    "Send a handle to watch:\n" +
    "<code>+ @username</code>\n\n" +
    "Bulk: <code>+ @u1 @u2 @u3 …</code> (up to 25 in one message)\n" +
    "Or /help for all commands."
  );
}

function buildAddSummaryHtml(
  results: { input: string; ok: boolean; username?: string; alreadyTracked?: boolean; error?: string }[]
): string {
  const added = results.filter((r) => r.ok && !r.alreadyTracked);
  const tracked = results.filter((r) => r.ok && r.alreadyTracked);
  const failed = results.filter((r) => !r.ok);

  const lines: string[] = [];
  for (const r of added) lines.push(`✅ <b>@${esc(r.username ?? r.input)}</b> — now on the radar`);
  for (const r of tracked) lines.push(`♻️ @${esc(r.username ?? r.input)} — already tracked`);
  for (const r of failed) lines.push(`❌ @${esc(r.input)} — ${esc(r.error ?? "could not add")}`);

  const head = added.length
    ? `📡 <b>Radar updated</b> — ${added.length} account${added.length > 1 ? "s" : ""} added`
    : "📡 <b>No new accounts added</b>";

  const tail = added.length
    ? "\n\n🔔 New follows &amp; posts will ping this chat. Replies, reposts &amp; likes show on the dashboard."
    : "";

  return [head, "", ...lines].join("\n") + tail;
}

/**
 * Hint for a bare /remove (or /delete) with no handles. MUST be a REMOVE
 * hint — sending the add-hint here was a real bug (2026-10-03: user typed
 * /remove and got "Send a handle to watch", which reads as if the bot is
 * trying to ADD an account).
 */
function buildRemoveHintHtml(): string {
  return (
    "Send a handle to stop watching:\n" +
    "<code>- @username</code>\n\n" +
    "Bulk: <code>- @u1 @u2 @u3 …</code> (up to 25 in one message)\n" +
    "Or /list to see who's on the radar."
  );
}

function buildRemoveHtml(
  results: { handle: string; removed: boolean }[]
): string {
  const removed = results.filter((r) => r.removed);
  const missing = results.filter((r) => !r.removed);

  const lines: string[] = [];
  for (const r of removed) lines.push(`🗑 <b>@${esc(r.handle)}</b> — removed from the radar`);
  for (const r of missing) lines.push(`❓ @${esc(r.handle)} — wasn't on the radar`);

  const head = removed.length
    ? `📡 <b>Radar updated</b> — ${removed.length} account${removed.length > 1 ? "s" : ""} removed`
    : "📡 <b>Nothing removed</b>";
  const tail = removed.length
    ? "\n\nTheir future events will no longer ping this chat or appear on the dashboard."
    : "";

  return [head, "", ...lines].join("\n") + tail;
}

/**
 * Live follower counts for a batch of accounts, gently (5 FixTweet lookups at
 * a time — same pacing as the follow digest). Returns accountId → count ONLY
 * where the live lookup succeeded; callers fall back to the DB snapshot.
 *
 * Why live: /list prints exact numbers for accounts under 10K, so even an
 * 8-follower drift between "last recorded snapshot" and reality reads as
 * WRONG to anyone cross-checking X. Counts only refresh in the DB when a
 * change crosses the alert threshold (max(10, 0.05%)), so quiet accounts
 * would display stale exact digits forever. /list is a rare, manual command —
 * a handful of keyless lookups per invocation is the cheapest way to make it
 * accurate AT SEND TIME. (2026-10-03: the "1,000 followers" bug report was
 * the stale mid-Task-12 process; this removes the whole staleness class.)
 */
async function fetchLiveFollowers(
  accounts: { id: string; username: string }[]
): Promise<Map<string, number>> {
  const live = new Map<string, number>();
  for (let i = 0; i < accounts.length; i += 5) {
    const batch = accounts.slice(i, i + 5);
    await Promise.all(
      batch.map(async (a) => {
        try {
          const p = await fetchProfileKeyless(a.username);
          if (p.ok && typeof p.followers === "number") live.set(a.id, p.followers);
        } catch {
          /* best-effort — DB snapshot covers this account */
        }
      })
    );
  }
  return live;
}

/** 📡 /list reply — watchlist with counts + live follower reach. Exposed for tests/demos. */
export async function buildListHtml(): Promise<string> {
  const accounts = await db.watchedAccount.findMany({
    where: { active: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, username: true, displayName: true },
  });
  if (accounts.length === 0) {
    return "📡 <b>Your radar is empty.</b>\n\nAdd your first account:\n<code>+ @username</code>";
  }

  // Follower reach per account, freshest possible:
  //   1. LIVE FixTweet lookup (accurate at send time — no scan-lag drift)
  //   2. fallback: newest PROFILE snapshot in the DB (free, offline-safe)
  const shown = accounts.slice(0, 40);
  const [liveFollowers, profileRows] = await Promise.all([
    fetchLiveFollowers(shown),
    db.activityEvent.findMany({
      where: { type: "PROFILE", accountId: { in: accounts.map((a) => a.id) }, metrics: { not: null } },
      orderBy: { detectedAt: "desc" },
      select: { accountId: true, metrics: true },
    }),
  ]);
  const snapshotByAccount = new Map<string, number>();
  for (const row of profileRows) {
    if (snapshotByAccount.has(row.accountId)) continue; // rows are newest-first
    try {
      const m = JSON.parse(row.metrics ?? "") as { followers?: number };
      if (typeof m.followers === "number") snapshotByAccount.set(row.accountId, m.followers);
    } catch {
      /* malformed metrics — skip */
    }
  }

  const lines = shown.map((a, i) => {
    const name = a.displayName && a.displayName !== a.username ? ` — <b>${esc(a.displayName)}</b>` : "";
    const fol = liveFollowers.get(a.id) ?? snapshotByAccount.get(a.id);
    const reach = fol != null ? ` · ${formatFollowers(fol)} followers` : "";
    return `${i + 1}. <a href="https://x.com/${esc(a.username)}">@${esc(a.username)}</a>${name}${reach}`;
  });
  const extra = accounts.length > shown.length ? `\n…+ ${accounts.length - shown.length} more` : "";
  return (
    `📡 <b>Your radar — watching ${accounts.length} account${accounts.length > 1 ? "s" : ""}</b>\n\n` +
    lines.join("\n") +
    extra +
    "\n\n➕ <code>+ @username</code> to add · ➖ <code>- @username</code> to remove"
  );
}

// ---------------------------------------------------------------------------
// "/" command menu — ANONYMITY LOCKED
// ---------------------------------------------------------------------------

const BOT_COMMANDS = [
  { command: "list", description: "Watchlist — every account on your radar" },
  { command: "add", description: "Watch accounts — + @u1 @u2 (bulk ok)" },
  { command: "remove", description: "Stop watching an account" },
  { command: "guard", description: "Arm the link guard (send it in your group)" },
  { command: "unguard", description: "Disarm the link guard" },
  { command: "help", description: "What TweetRadar watches & how it alerts" },
];

/** Pure: only a PRIVATE chat may claim the alert target — groups/channels never. */
export function shouldAutoClaimChat(chatType: string | undefined): boolean {
  return !chatType || chatType === "private";
}

/** Pure: does this Telegram sender id belong to the owner (the alert chat)? */
export function isOwnerSender(
  senderId: number | null | undefined,
  ownerChatId: string | null | undefined
): boolean {
  return senderId != null && ownerChatId != null && String(senderId) === ownerChatId;
}

/** Re-exported for tests/consumers — the canonical constant lives in guard.ts. */
export { GROUP_ANONYMOUS_BOT_ID };

/**
 * Pure: does this message wear the ANONYMOUS mantle? Two shapes:
 *   · group/channel anonymous admin post  → from = GroupAnonymousBot
 *   · channel / "send as channel" post    → from is absent entirely
 * The REAL identity check happens in isOwnerGuardCommand via getChatMember —
 * this only decides whether that verification call is needed.
 */
export function looksLikeAnonymousPost(msg: TgMessage | undefined): boolean {
  if (!msg) return false;
  return !msg.from || msg.from.id === GROUP_ANONYMOUS_BOT_ID;
}

/**
 * Is this guard command genuinely from the bot's owner?
 *   1. Direct match — the sender id IS the alert chat id (normal case).
 *   2. Anonymous mantle — the group creator/admin posting anonymously (from =
 *      GroupAnonymousBot) or a channel post (no from). Telegram hides the real
 *      id, so a bare id-compare would reject the OWNER'S OWN /guard (seen live:
 *      the creator of "GM.Airdrop chat" arming got total silence). We accept it
 *      ONLY if getChatMember confirms the owner is creator/administrator of the
 *      very chat the command was sent in — a fact strangers cannot spoof.
 */
export async function isOwnerGuardCommand(
  msg: TgMessage | undefined,
  chat: TgChat,
  botToken: string | null,
  ownerChatId: string | null | undefined
): Promise<boolean> {
  if (isOwnerSender(msg?.from?.id, ownerChatId)) return true;
  if (!looksLikeAnonymousPost(msg)) return false;
  if (!botToken || !ownerChatId) return false;
  const ownerId = Number(ownerChatId);
  if (!Number.isFinite(ownerId)) return false;
  const status = await getChatMemberStatus(botToken, String(chat.id), ownerId);
  return status === "creator" || status === "administrator";
}

/** Pure: broadcast channels have no members to ban — Delete alone is enough there. */
export function chatNeedsRestrictRight(chatType: string | undefined): boolean {
  return chatType !== "channel";
}

/**
 * Pure: the exact set of setMyCommands calls an anonymity sync must make.
 * Every PUBLIC scope is wiped to an empty menu — a stranger who opens the
 * bot sees no commands at all — and the full menu is scoped ONLY to the
 * owner's private chat (when the alert target is known).
 */
export function menuSyncPlan(
  ownerChatId: string | null
): { scope: Record<string, unknown>; commands: { command: string; description: string }[] }[] {
  const plan = [
    { scope: { type: "default" } as Record<string, unknown>, commands: [] as typeof BOT_COMMANDS },
    { scope: { type: "all_private_chats" } as Record<string, unknown>, commands: [] as typeof BOT_COMMANDS },
    { scope: { type: "all_group_chats" } as Record<string, unknown>, commands: [] as typeof BOT_COMMANDS },
    { scope: { type: "all_chat_administrators" } as Record<string, unknown>, commands: [] as typeof BOT_COMMANDS },
  ];
  if (ownerChatId) {
    plan.push({ scope: { type: "chat", chat_id: ownerChatId }, commands: BOT_COMMANDS });
  }
  return plan;
}

/** Minimal Bot API call helper — returns ok only. Never throws. */
async function tgMethod(botToken: string, method: string, params: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return res.ok && Boolean(data?.ok);
  } catch {
    return false;
  }
}

let syncedForToken: string | null = null;

/**
 * Anonymity sync (idempotent, free, re-run per bot token):
 *   1. Wipe the command menu from EVERY public scope.
 *   2. Blank the bot's public description + short description (the About
 *      blurb must not hint at what the bot does).
 *   3. Scope the full menu to the owner's private chat only.
 * Re-syncs automatically when the bot token changes. Retries on the next
 * poll until every call succeeds.
 */
export async function syncBotCommands(botToken: string, force = false): Promise<boolean> {
  if (!force && syncedForToken === botToken) return true;
  try {
    const s = await getSettings();
    let allOk = true;
    for (const item of menuSyncPlan(s.telegramChatId)) {
      const ok = await tgMethod(botToken, "setMyCommands", {
        commands: item.commands,
        scope: item.scope,
      });
      if (!ok) {
        allOk = false;
        console.error(`[TweetRadar] anonymity: setMyCommands failed for scope ${JSON.stringify(item.scope)}`);
      }
    }
    const descOk = await tgMethod(botToken, "setMyDescription", { description: "" });
    const shortOk = await tgMethod(botToken, "setMyShortDescription", { short_description: "" });
    if (!descOk || !shortOk) {
      allOk = false;
      console.error(`[TweetRadar] anonymity: description wipe failed (desc=${descOk} short=${shortOk})`);
    }
    if (allOk) {
      syncedForToken = botToken;
      console.log(
        `[TweetRadar] anonymity lock applied — public menu + description wiped (owner chat ${s.telegramChatId ? "scoped menu armed" : "not yet claimed"})`
      );
    } else {
      console.error("[TweetRadar] anonymity sync incomplete — retrying next poll");
    }
    return allOk;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Update handling
// ---------------------------------------------------------------------------

interface TgChat {
  id: number;
  type?: string;
  title?: string;
}

interface TgUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
}

interface TgMessage {
  message_id?: number;
  from?: TgUser;
  sender_chat?: TgChat;
  is_automatic_forward?: boolean;
  author_signature?: string;
  text?: string;
  caption?: string;
  entities?: TgEntity[];
  caption_entities?: TgEntity[];
  chat?: TgChat;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  channel_post?: TgMessage;
  edited_channel_post?: TgMessage;
}

/**
 * First PRIVATE chat to message the bot claims the alert target (only if
 * unset). Groups/channels can NEVER claim — adding the bot to any random
 * group must not redirect the radar's alerts. Once claimed, the lock is
 * permanent: every other chat is met with silence.
 */
async function autoClaimChat(chat: TgChat): Promise<void> {
  if (!shouldAutoClaimChat(chat.type)) return;
  try {
    const s = await getSettings();
    if (s.telegramChatId) return;
    await saveSettings({ telegramChatId: String(chat.id) });
    console.log(`[TweetRadar] chat ${chat.id} auto-claimed as the alert target`);
  } catch {
    /* non-fatal */
  }
}

/**
 * LIVE SELF-TEST of the guard's delete+ban pipeline (/guard test).
 *
 * 1. Verifies the guard is armed and the bot still holds admin/delete/ban.
 * 2. Posts a marker message (with a link) into the guarded chat — members may
 *    glimpse it for a split second.
 * 3. Feeds that marker through the REAL handleGuardMessage path wearing a
 *    fake member identity — the same detect → classify → delete → ban flow a
 *    violating member's message takes.
 * 4. Reports honest, per-step results to the owner's DM (the auto-report is
 *    suppressed; the self-test consolidates everything into one message).
 */
const SELF_TEST_MEMBER_ID = 777_000_001;

async function sendMarker(
  token: string,
  chatId: string,
  text: string
): Promise<{ ok: boolean; messageId?: number; error?: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; description?: string; result?: { message_id?: number } }
      | null;
    if (!res.ok || !data?.ok) return { ok: false, error: data?.description || `HTTP ${res.status}` };
    return { ok: true, messageId: data.result?.message_id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

async function runGuardSelfTest(
  s: Awaited<ReturnType<typeof getSettings>>,
  send: (html: string) => Promise<unknown>
): Promise<void> {
  if (!s.telegramBotToken) return;
  if (!s.guardChatId) {
    await send("🛡 No guard is armed — arm it first with <code>/guard</code> in the group, then run <code>/guard test</code>.");
    return;
  }

  // Step 0: rights check — the same prerequisites arming verified.
  const rights = await getBotRights(s.telegramBotToken, s.guardChatId);
  if (!rights.isAdmin || !rights.canDelete || !rights.canRestrict) {
    await send(
      "⚠️ <b>Self-test blocked</b> — the bot's rights in the guarded chat are incomplete:\n" +
        `• ${rights.isAdmin ? "✅" : "❌"} Admin · ${rights.canDelete ? "✅" : "❌"} Delete messages · ${rights.canRestrict ? "✅" : "❌"} Ban users\n\n` +
        "Fix the admin permissions, then re-run <code>/guard test</code>."
    );
    return;
  }

  // Step 1: post the marker into the guarded chat.
  const markerText = "🧪 guard self-test marker — https://example.com/guard-self-test";
  const marker = await sendMarker(s.telegramBotToken, s.guardChatId, markerText);
  if (!marker.ok || typeof marker.messageId !== "number") {
    await send(`⚠️ <b>Self-test failed at step 1</b> — could not post the marker message: ${esc(marker.error ?? "unknown")}`);
    return;
  }

  // Step 2: run the marker through the REAL enforcement path as a fake member.
  const linkStart = markerText.indexOf("https://");
  const outcome = await handleGuardMessage(
    {
      message_id: marker.messageId,
      from: { id: SELF_TEST_MEMBER_ID, first_name: "SelfTest Member" },
      text: markerText,
      entities: [{ type: "url", offset: linkStart, length: markerText.length - linkStart }],
    },
    s,
    undefined,
    { suppressReport: true }
  );

  // Step 3: if the delete somehow failed, clean the marker up manually.
  let cleanupNote = "";
  if (outcome.action === "failed") {
    const wiped = await tgMethod(s.telegramBotToken, "deleteMessage", {
      chat_id: s.guardChatId,
      message_id: marker.messageId,
    });
    cleanupNote = wiped ? "\n🧹 The marker was cleaned up manually." : "";
  }

  // Step 4: honest per-step report.
  const chatLabel = `<code>${esc(s.guardChatId)}</code>`;
  const lines: string[] = [];
  if (outcome.action === "deleted" || outcome.action === "deleted+banned") {
    lines.push("🧪 <b>Guard self-test PASSED</b>\n");
    lines.push(`✅ <b>Detection</b> — the link was classified as a violation by the exact pipeline member messages go through.`);
    lines.push(`✅ <b>Delete</b> — the marker message was really deleted from ${chatLabel}.`);
    if (outcome.action === "deleted+banned") {
      await tgMethod(s.telegramBotToken, "unbanChatMember", {
        chat_id: s.guardChatId,
        user_id: SELF_TEST_MEMBER_ID,
      });
      lines.push(`✅ <b>Ban</b> — the ban command executed against the dummy id (banned, then instantly unbanned).`);
    } else {
      lines.push(`✅ <b>Ban</b> — the ban command fired and reached Telegram, which rejected the dummy id as expected (no such member). Your bot's <b>Ban users</b> right is confirmed: <code>can_restrict_members ✓</code>.`);
    }
    lines.push(
      "\n🛡 Everything is wired correctly: a real member who drops any link will be <b>deleted + banned</b>, silently — with the report landing in this chat.\n\n" +
        "Channel auto-forwards, anonymous admins and sent-as-channel posts remain exempt, exactly as you specified."
    );
  } else {
    lines.push(`⚠️ <b>Guard self-test INCOMPLETE</b> — outcome: <code>${esc(outcome.action)}</code>${outcome.detail ? ` — ${esc(outcome.detail)}` : ""}`);
    lines.push(cleanupNote);
    lines.push("\nCheck the bot's admin rights in the guarded chat and re-run <code>/guard test</code>.");
  }
  await send(lines.join("\n"));
}

/**
 * Owner-driven Channel Guard control. Arming happens INSIDE the chat to be
 * protected (that is how the bot learns the chat id); status works anywhere
 * the owner writes. EVERY reply goes to the owner's PRIVATE chat — never
 * into the group — and the owner's own /guard command message is wiped from
 * the group afterwards (stealth delete, best-effort), so members never see
 * the bot or the owner interact with it. The bot refuses to arm a chat where
 * it cannot actually enforce (not admin / cannot delete) — a broken guard is
 * worse than no guard. Broadcast channels are supported: they have no
 * members to ban, so Delete rights alone suffice there.
 */
async function handleGuardCommand(
  parsed: ParsedCommand,
  chat: TgChat,
  s: Awaited<ReturnType<typeof getSettings>>,
  send: (html: string) => Promise<unknown>,
  commandMessageId?: number
): Promise<void> {
  const arg = parsed.handles[0] ?? "";
  const isPrivate = !chat.type || chat.type === "private";
  const isChannel = chat.type === "channel";
  const chatLabel = chat.title ? `<b>${esc(chat.title)}</b>` : `<code>${esc(String(chat.id))}</code>`;

  const statusHtml = async (): Promise<string> => {
    const last24h = s.guardChatId
      ? await db.guardLog.count({
          where: { chatId: s.guardChatId, createdAt: { gte: new Date(Date.now() - 86_400_000) } },
        })
      : 0;
    const armed = s.guardChatId
      ? `🛡 Armed for <code>${esc(s.guardChatId)}</code> · ${s.guardEnabled ? "ACTIVE" : "PAUSED"} · ${s.guardStrict ? "strict" : "admins exempt"} · ${last24h} enforcement${last24h === 1 ? "" : "s"} (24h)`
      : "🛡 Guard is <b>not armed</b> for any chat.";
    return armed;
  };

  // STEALTH: wipe the owner's own /guard message out of the group so members
  // never even see the arming happen. Best-effort — a failed wipe (missing
  // rights, message too old) must not block the reply.
  const stealthWipe = async (): Promise<void> => {
    if (isPrivate || !commandMessageId || !s.telegramBotToken) return;
    await tgMethod(s.telegramBotToken, "deleteMessage", {
      chat_id: String(chat.id),
      message_id: commandMessageId,
    });
  };

  if (parsed.kind === "unguard") {
    await stealthWipe();
    if (!s.guardChatId) {
      await send("🛡 No guard is armed — nothing to disarm.");
      return;
    }
    await saveSettings({ guardChatId: null, guardEnabled: true });
    await send(
      "🛡 <b>Link Guard disarmed.</b> Messages in that chat are no longer monitored. Nothing was posted there — members saw nothing."
    );
    return;
  }

  // /guard test — live self-test of the enforcement pipeline (works from the
  // DM or the guarded chat; the marker is posted into the ARMED chat either way).
  if (arg === "test") {
    await stealthWipe();
    await runGuardSelfTest(s, send);
    return;
  }

  // /guard [strict|status]
  if (arg === "status" || isPrivate) {
    const hint = isPrivate && !s.guardChatId
      ? "\n\nTo arm: add the bot to your channel/group as admin (allow <i>Delete messages</i> + <i>Ban users</i> — channels only need <i>Delete</i>), then send <code>/guard</code> in there."
      : "";
    await stealthWipe();
    await send(`🛡 <b>Link Guard status</b>\n\n${await statusHtml()}${hint}`);
    return;
  }

  // Arming a real group/channel — verify enforcement capability first.
  const rights = await getBotRights(s.telegramBotToken!, String(chat.id));
  const cannotEnforce =
    !rights.isAdmin || !rights.canDelete || (chatNeedsRestrictRight(chat.type) && !rights.canRestrict);
  if (cannotEnforce) {
    await send(
      "⚠️ <b>Cannot arm the guard yet.</b>\n\nPromote me to <b>admin</b> of " +
        `${chatLabel} with these permissions:\n` +
        `• ${rights.canDelete ? "✅" : "❌"} <i>Delete messages</i>\n` +
        (isChannel
          ? "• <i>Ban users</i> — not required for channels\n\n"
          : `• ${rights.canRestrict ? "✅" : "❌"} <i>Ban users</i>\n\n`) +
        "Then send <code>/guard</code> there again. Nothing was posted in the chat — members saw nothing."
    );
    return;
  }

  await saveSettings({
    guardChatId: String(chat.id),
    guardEnabled: true,
    guardStrict: arg === "strict",
  });
  await stealthWipe();
  await send(
    `🛡 <b>Link Guard ARMED</b> for ${chatLabel} — 24/7, invisible.\n\n` +
      "Any member who drops a link: message deleted + member banned — plain URLs, hyperlinks and media captions. " +
      "The bot NEVER posts in the chat: no warnings, no confirmations. Enforcement is completely silent and every report lands in this private chat.\n\n" +
      `Policy: ${arg === "strict" ? "<b>strict</b> — admins are banned too" : "admins are exempt"} · you are always exempt.\n` +
      "<code>/unguard</code> here or in the chat disarms it — the command is wiped from the chat either way."
  );
}

/** Process one Telegram update. Never throws. */
export async function handleTelegramUpdate(update: TgUpdate): Promise<void> {
  const msg = update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;
  const chat = msg?.chat;
  if (!chat) return;

  try {
    const s = await getSettings();
    if (!s.telegramBotToken) return;
    const chatId = String(chat.id);

    // ── OWNER GUARD COMMANDS first: /guard, /guard strict|status and
    // /unguard are recognized BEFORE the armed-chat dispatch so the owner can
    // arm AND disarm from inside the protected chat itself (the guard engine
    // would otherwise swallow them as ordinary chatter). Only the owner's
    // identity passes — direct id match, or an anonymous creator/admin post
    // verified via getChatMember. A stranger's /guard is never acknowledged.
    const text = msg?.text ?? msg?.caption;
    const early = text ? parseCommand(text) : null;
    if (early && (early.kind === "guard" || early.kind === "unguard")) {
      if (await isOwnerGuardCommand(msg, chat, s.telegramBotToken, s.telegramChatId)) {
        const send = (html: string) =>
          sendTelegramHtml(s.telegramBotToken!, s.telegramChatId!, html);
        await handleGuardCommand(early, chat, s, send, msg?.message_id);
      }
      // Non-owner guard commands fall through: in an armed chat the guard
      // engine below judges the message itself; in an unarmed chat the
      // security gate below drops them in total silence.
    }

    // ── CHANNEL GUARD: any message (new or edited) in the armed chat goes to
    // the guard engine — BEFORE the owner-chat gate, because guarded chat ids
    // are never the owner's private chat. Media-only spam is covered too.
    if (s.guardChatId && s.guardChatId === chatId) {
      await handleGuardMessage(msg, s, chat.title);
      return;
    }

    if (!text) return;

    await autoClaimChat(chat);
    const parsed = parseCommand(text);

    // ── Guard commands from anyone but the owner (the owner was handled
    // above): dropped WITHOUT any reply — the bot must not even acknowledge
    // that it understood. No error, no menu, no hint a guard exists.
    if (parsed.kind === "guard" || parsed.kind === "unguard") {
      console.log(`[TweetRadar] guard command from unauthorized sender in chat ${chatId}`);
      return;
    }

    if (!s.telegramChatId) return;

    // SECURITY GATE — only the claimed alert chat may control the radar.
    // Anything sent by ANY other chat is dropped in TOTAL SILENCE: a stranger
    // who discovers the bot's username gets no reply, no error, no hint that
    // a command was understood — the bot simply does not exist for them.
    // (Unclaimed state: only a PRIVATE chat can claim the bot, which is
    // exactly the owner's setup flow.)
    if (s.telegramChatId && s.telegramChatId !== chatId) {
      console.log(`[TweetRadar] ignored command from unauthorized chat ${chatId}`);
      return;
    }
    const send = (html: string) => sendTelegramHtml(s.telegramBotToken!, chatId, html);

    switch (parsed.kind) {
      case "help": {
        await send(buildHelpHtml());
        return;
      }
      case "list": {
        await send(await buildListHtml());
        return;
      }
      case "add": {
        if (parsed.handles.length === 0) {
          await send(buildAddHintHtml());
          return;
        }
        const limited = parsed.handles.slice(0, MAX_HANDLES);
        const dropped = parsed.handles.length - limited.length;
        const results = await addWatchedAccounts(limited);
        if (results.some((r) => r.ok && !r.alreadyTracked)) {
          void runScan("manual").catch(() => undefined);
        }
        await send(
          (dropped > 0
            ? `⚠️ ${dropped} handle${dropped > 1 ? "s" : ""} ignored — ${MAX_HANDLES} max per message.\n\n`
            : "") + buildAddSummaryHtml(results)
        );
        return;
      }
      case "remove": {
        if (parsed.handles.length === 0) {
          await send(buildRemoveHintHtml());
          return;
        }
        const outcomes: { handle: string; removed: boolean }[] = [];
        const all = await db.watchedAccount.findMany({ select: { id: true, username: true } });
        for (const handle of parsed.handles.slice(0, MAX_HANDLES)) {
          // X handles are case-insensitive — match on lowercase
          const account = all.find((a) => a.username.toLowerCase() === handle.toLowerCase());
          if (!account) {
            outcomes.push({ handle: normalizeHandle(handle), removed: false });
            continue;
          }
          try {
            await db.watchedAccount.delete({ where: { id: account.id } });
            outcomes.push({ handle: account.username, removed: true });
          } catch (err) {
            // One bad delete must not silence the whole reply — report it.
            console.error(`[TweetRadar] failed to remove ${account.username}:`, err instanceof Error ? err.message : err);
            outcomes.push({ handle: account.username, removed: false });
          }
        }
        await send(buildRemoveHtml(outcomes));
        return;
      }
      default: {
        await send(
          "🤔 Didn't catch that.\n\nWatch an account with:\n<code>+ @username</code>\n\n/help shows all commands."
        );
      }
    }
  } catch (err) {
    console.error("[TweetRadar] failed to handle Telegram update:", err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// getUpdates polling loop
// ---------------------------------------------------------------------------

/** One getUpdates sweep. Exposed for tests. Returns the number of updates handled. */
export async function pollOnce(): Promise<number> {
  const s = await getSettings();
  if (!s.telegramBotToken) return 0;

  // Anonymity sync once per bot token (wipes public menus/description,
  // scopes the command menu to the owner's chat only)
  if (syncedForToken !== s.telegramBotToken) void syncBotCommands(s.telegramBotToken).catch(() => undefined);

  let data: { ok?: boolean; description?: string; result?: TgUpdate[] } | null = null;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${s.telegramBotToken}/getUpdates?offset=${s.telegramOffset}&limit=20&timeout=0`,
      { signal: AbortSignal.timeout(10_000) }
    );
    data = (await res.json().catch(() => null)) as { ok?: boolean; description?: string; result?: TgUpdate[] } | null;
    if (!res.ok || !data?.ok) {
      const desc = data?.description || `HTTP ${res.status}`;
      // 409 = a webhook is set / another consumer — log once per cycle, no spam.
      console.error(`[TweetRadar] getUpdates failed: ${desc}`);
      return 0;
    }
  } catch {
    return 0; // network hiccup — next tick retries
  }

  let maxId = -1;
  for (const u of data.result ?? []) {
    if (typeof u.update_id === "number" && u.update_id > maxId) maxId = u.update_id;
    await handleTelegramUpdate(u);
  }
  if (maxId >= 0 && maxId + 1 !== s.telegramOffset) {
    await saveSettings({ telegramOffset: maxId + 1 });
  }
  return data.result?.length ?? 0;
}

interface PollerState {
  timer: ReturnType<typeof setTimeout> | null;
  started: boolean;
  polling: boolean;
  startedAt: Date | null;
  lastPollAt: Date | null;
  lastHandled: number;
}

const globalForPoller = globalThis as unknown as {
  tweetRadarTgPoller: PollerState | undefined;
};

const state: PollerState =
  globalForPoller.tweetRadarTgPoller ?? {
    timer: null,
    started: false,
    polling: false,
    startedAt: null,
    lastPollAt: null,
    lastHandled: 0,
  };
globalForPoller.tweetRadarTgPoller = state;

async function loop(): Promise<void> {
  if (state.polling) {
    scheduleNext();
    return;
  }
  state.polling = true;
  try {
    state.lastHandled = await pollOnce();
  } catch (err) {
    console.error("[TweetRadar] telegram poll error:", err instanceof Error ? err.message : err);
  } finally {
    state.polling = false;
    state.lastPollAt = new Date();
    scheduleNext();
  }
}

function scheduleNext(): void {
  if (!state.started) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => void loop(), POLL_MS);
}

/** Idempotently start the Telegram command poller. Called from instrumentation. */
export function startTelegramCommandPoller(): void {
  if (state.started) return;
  state.started = true;
  state.startedAt = new Date();
  state.timer = setTimeout(() => void loop(), 3_000);
  console.log("[TweetRadar] telegram command poller started (every 5s)");
}

export function getTelegramPollerState(): {
  started: boolean;
  lastPollAt: string | null;
  lastHandled: number;
} {
  return {
    started: state.started,
    lastPollAt: state.lastPollAt ? state.lastPollAt.toISOString() : null,
    lastHandled: state.lastHandled,
  };
}
