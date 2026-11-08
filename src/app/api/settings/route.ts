import { NextRequest, NextResponse } from "next/server";
import { getSettings, saveSettings, maskSecret, hasSession } from "@/lib/settings";

export async function GET() {
  const s = await getSettings();
  return NextResponse.json({
    telegramBotToken: maskSecret(s.telegramBotToken),
    telegramChatId: s.telegramChatId,
    xAuthToken: maskSecret(s.xAuthToken),
    xCt0: maskSecret(s.xCt0),
    pollIntervalSec: s.pollIntervalSec,
    alertsEnabled: s.alertsEnabled,
    notifyOnFollows: s.notifyOnFollows,
    notifyOnPosts: s.notifyOnPosts,
    notifyOnReplies: s.notifyOnReplies,
    notifyOnReposts: s.notifyOnReposts,
    hasTelegramToken: Boolean(s.telegramBotToken),
    hasSession: hasSession(s),
    sessionMode: hasSession(s),
  });
}

export async function PUT(req: NextRequest) {
  let body: {
    telegramBotToken?: string | null;
    telegramChatId?: string | null;
    xAuthToken?: string | null;
    xCt0?: string | null;
    pollIntervalSec?: number;
    alertsEnabled?: boolean;
    notifyOnFollows?: boolean;
    notifyOnPosts?: boolean;
    notifyOnReplies?: boolean;
    notifyOnReposts?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Masked values (containing •) mean "keep current" — don't overwrite.
  // Empty strings explicitly clear the stored value.
  const patch: Record<string, unknown> = {};
  if ("telegramBotToken" in body && !(body.telegramBotToken ?? "").includes("•")) {
    patch.telegramBotToken = body.telegramBotToken;
  }
  if ("xAuthToken" in body && !(body.xAuthToken ?? "").includes("•")) {
    patch.xAuthToken = body.xAuthToken;
  }
  if ("xCt0" in body && !(body.xCt0 ?? "").includes("•")) {
    patch.xCt0 = body.xCt0;
  }
  // Coerce defensively — a numeric chat_id (Telegram ids are numbers in the
  // raw API) would otherwise fail Prisma's String validation with a 500.
  if ("telegramChatId" in body) {
    patch.telegramChatId = body.telegramChatId == null ? null : String(body.telegramChatId);
  }
  if ("pollIntervalSec" in body) patch.pollIntervalSec = Number(body.pollIntervalSec);
  if ("alertsEnabled" in body) patch.alertsEnabled = Boolean(body.alertsEnabled);
  for (const key of ["notifyOnFollows", "notifyOnPosts", "notifyOnReplies", "notifyOnReposts"] as const) {
    if (key in body) patch[key] = Boolean(body[key]);
  }

  const saved = await saveSettings(patch);
  return NextResponse.json({
    telegramBotToken: maskSecret(saved.telegramBotToken),
    telegramChatId: saved.telegramChatId,
    xAuthToken: maskSecret(saved.xAuthToken),
    xCt0: maskSecret(saved.xCt0),
    pollIntervalSec: saved.pollIntervalSec,
    alertsEnabled: saved.alertsEnabled,
    notifyOnFollows: saved.notifyOnFollows,
    notifyOnPosts: saved.notifyOnPosts,
    notifyOnReplies: saved.notifyOnReplies,
    notifyOnReposts: saved.notifyOnReposts,
    hasTelegramToken: Boolean(saved.telegramBotToken),
    hasSession: hasSession(saved),
    sessionMode: hasSession(saved),
  });
}
