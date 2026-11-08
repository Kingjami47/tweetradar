import { db } from "@/lib/db";
import { isValidAuthToken } from "@/lib/x-graphql";

export interface AppSettings {
  telegramBotToken: string | null;
  telegramChatId: string | null;
  /** Burner account auth_token cookie — powers free web-GraphQL timeline reads */
  xAuthToken: string | null;
  /** Burner account ct0 cookie (csrf) — sent as x-csrf-token alongside auth_token */
  xCt0: string | null;
  pollIntervalSec: number;
  alertsEnabled: boolean;
  /** Telegram notification scope — which event types ping Telegram (dashboard always keeps everything) */
  notifyOnFollows: boolean;
  notifyOnPosts: boolean;
  notifyOnReplies: boolean;
  notifyOnReposts: boolean;
  /** getUpdates cursor for the two-way bot (command poller); reset on token change */
  telegramOffset: number;
  /** Channel Guard — armed chat id (group/channel protected from links) */
  guardChatId: string | null;
  /** Channel Guard pause switch (false = ignore messages even when armed) */
  guardEnabled: boolean;
  /** Channel Guard strict mode — admins treated like members (owner always exempt) */
  guardStrict: boolean;
}

const DEFAULTS: AppSettings = {
  telegramBotToken: null,
  telegramChatId: null,
  xAuthToken: null,
  xCt0: null,
  pollIntervalSec: 60,
  alertsEnabled: true,
  notifyOnFollows: true,
  notifyOnPosts: true,
  notifyOnReplies: false,
  notifyOnReposts: false,
  telegramOffset: 0,
  guardChatId: null,
  guardEnabled: true,
  guardStrict: false,
};

/** Fetch singleton settings row, creating it with defaults if missing. */
export async function getSettings(): Promise<AppSettings> {
  let row = await db.settings.findUnique({ where: { id: "default" } });
  if (!row) {
    row = await db.settings.create({ data: { id: "default" } });
  }
  return {
    telegramBotToken: row.telegramBotToken ?? null,
    telegramChatId: row.telegramChatId ?? null,
    xAuthToken: row.xAuthToken ?? null,
    xCt0: row.xCt0 ?? null,
    pollIntervalSec: row.pollIntervalSec ?? 60,
    alertsEnabled: row.alertsEnabled ?? true,
    notifyOnFollows: row.notifyOnFollows ?? true,
    notifyOnPosts: row.notifyOnPosts ?? true,
    notifyOnReplies: row.notifyOnReplies ?? false,
    notifyOnReposts: row.notifyOnReposts ?? false,
    telegramOffset: row.telegramOffset ?? 0,
    guardChatId: row.guardChatId ?? null,
    guardEnabled: row.guardEnabled ?? true,
    guardStrict: row.guardStrict ?? false,
  };
}

/** Merge-patch settings. Null values are stored as null (explicitly cleared). */
export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  // Read current row first — needed to detect a bot-token change (offset reset).
  const current = await db.settings.findUnique({ where: { id: "default" } });
  const data: Record<string, unknown> = {};
  if ("telegramBotToken" in patch) {
    const next = patch.telegramBotToken || null;
    data.telegramBotToken = next;
    if (next !== (current?.telegramBotToken ?? null)) {
      // Different bot → different update-id space → start the cursor fresh.
      data.telegramOffset = 0;
    }
  }
  if ("telegramChatId" in patch) data.telegramChatId = patch.telegramChatId || null;
  if ("xAuthToken" in patch) data.xAuthToken = patch.xAuthToken || null;
  if ("xCt0" in patch) data.xCt0 = patch.xCt0 || null;
  if ("pollIntervalSec" in patch) {
    const v = Number(patch.pollIntervalSec);
    data.pollIntervalSec = Number.isFinite(v) ? Math.min(Math.max(Math.round(v), 15), 3600) : 60;
  }
  if ("alertsEnabled" in patch) data.alertsEnabled = Boolean(patch.alertsEnabled);
  for (const key of ["notifyOnFollows", "notifyOnPosts", "notifyOnReplies", "notifyOnReposts"] as const) {
    if (key in patch) data[key] = Boolean(patch[key]);
  }
  if ("telegramOffset" in patch) {
    const v = Number(patch.telegramOffset);
    data.telegramOffset = Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
  }
  if ("guardChatId" in patch) data.guardChatId = patch.guardChatId || null;
  if ("guardEnabled" in patch) data.guardEnabled = Boolean(patch.guardEnabled);
  if ("guardStrict" in patch) data.guardStrict = Boolean(patch.guardStrict);

  await db.settings.upsert({
    where: { id: "default" },
    update: data,
    create: { id: "default", ...data },
  });
  return getSettings();
}

/** True when an X web-session (burner auth_token) is configured — enables free timeline reads. */
export function hasSession(s: Pick<AppSettings, "xAuthToken">): boolean {
  return isValidAuthToken(s.xAuthToken);
}

/** Mask secrets for safe display in the UI. */
export function maskSecret(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= 8) return "••••••••";
  return value.slice(0, 4) + "••••••••" + value.slice(-4);
}

export { DEFAULTS as SETTINGS_DEFAULTS };
