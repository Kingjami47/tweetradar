import { NextRequest, NextResponse } from "next/server";
import { getSettings } from "@/lib/settings";

interface TgChat {
  id: number;
  type?: string;
  title?: string;
  username?: string;
  first_name?: string;
}

interface TgUpdate {
  update_id?: number;
  message?: { chat?: TgChat; date?: number };
  edited_message?: { chat?: TgChat; date?: number };
  channel_post?: { chat?: TgChat; date?: number };
  edited_channel_post?: { chat?: TgChat; date?: number };
}

function chatLabel(chat: TgChat): string {
  if (chat.type === "group" || chat.type === "supergroup" || chat.type === "channel") {
    return chat.title ?? `chat ${chat.id}`;
  }
  return [chat.first_name, chat.username ? `(@${chat.username})` : ""]
    .filter(Boolean)
    .join(" ")
    .trim();
}

/**
 * POST /api/telegram/detect-chat — no more @userinfobot dance.
 * Reads the bot's recent updates and returns the newest chat that messaged it.
 * Flow: user pastes the BotFather token → presses Start in Telegram → Detect.
 */
export async function POST(req: NextRequest) {
  let body: { telegramBotToken?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body — fall back to stored settings */
  }

  const s = await getSettings();
  const raw = (body.telegramBotToken ?? "").trim();
  const token = raw && !raw.includes("•") ? raw : s.telegramBotToken ?? "";
  if (!token) {
    return NextResponse.json(
      { error: "Paste your bot token from @BotFather first." },
      { status: 400 }
    );
  }

  type TgUpdatesResponse = { ok?: boolean; description?: string; result?: TgUpdate[] };
  let data: TgUpdatesResponse | null = null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=100`, {
      signal: AbortSignal.timeout(10_000),
    });
    data = (await res.json().catch(() => null)) as TgUpdatesResponse | null;
    if (!res.ok || !data?.ok) {
      const desc = data?.description || `Telegram HTTP ${res.status}`;
      const friendly = /401|unauthorized|not found/i.test(desc)
        ? "Token rejected by Telegram — copy it again from @BotFather (format: 123456789:AAE...)."
        : desc;
      return NextResponse.json({ error: friendly }, { status: 502 });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Network error reaching Telegram" },
      { status: 502 }
    );
  }

  // Newest chat wins (by message date; update_id as implicit tiebreak order).
  let best: { chat: TgChat; date: number } | null = null;
  for (const u of data.result ?? []) {
    for (const m of [u.message, u.edited_message, u.channel_post, u.edited_channel_post]) {
      if (!m?.chat) continue;
      const date = m.date ?? 0;
      if (!best || date >= best.date) best = { chat: m.chat, date };
    }
  }

  if (!best) {
    return NextResponse.json(
      { error: "No messages yet — open your bot in Telegram, press Start (or send any message), then hit Detect again." },
      { status: 404 }
    );
  }

  return NextResponse.json({
    ok: true,
    chatId: String(best.chat.id),
    label: chatLabel(best.chat),
  });
}
