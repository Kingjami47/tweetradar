import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") ?? "60", 10) || 60, 1), 200);
  const accountId = searchParams.get("accountId") ?? undefined;
  const type = searchParams.get("type") ?? undefined;
  const since = searchParams.get("since") ?? undefined;

  const where: Record<string, unknown> = {};
  if (accountId && accountId !== "all") where.accountId = accountId;
  if (type && type !== "all") where.type = type.toUpperCase();
  if (since) {
    const d = new Date(since);
    if (!Number.isNaN(d.getTime())) where.detectedAt = { gt: d };
  }

  const events = await db.activityEvent.findMany({
    where,
    orderBy: { detectedAt: "desc" },
    take: limit,
    include: { account: { select: { username: true, displayName: true, avatarColor: true } } },
  });

  return NextResponse.json(
    events.map((e) => ({
      id: e.id,
      type: e.type,
      text: e.text,
      url: e.url,
      targetUser: e.targetUser,
      // One malformed metrics row must never 500 the entire feed.
      metrics: e.metrics ? safeParseMetrics(e.metrics) : null,
      notified: e.notified,
      detectedAt: e.detectedAt,
      account: e.account,
    }))
  );
}

function safeParseMetrics(raw: string): Record<string, number> | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, number>;
    }
    return null;
  } catch {
    return null;
  }
}
