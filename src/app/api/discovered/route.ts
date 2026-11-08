import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * Smart Circle — accounts that watched accounts recently started following.
 * Aggregates FOLLOW events by target user, marks ones already on the watchlist.
 */
export async function GET() {
  const followEvents = await db.activityEvent.findMany({
    where: { type: "FOLLOW", targetUser: { not: null } },
    orderBy: { detectedAt: "desc" },
    take: 300,
    include: { account: { select: { username: true } } },
  });

  const watchlist = await db.watchedAccount.findMany({ select: { username: true } });
  const trackedLower = new Set(watchlist.map((a) => a.username.toLowerCase()));

  interface Agg {
    targetUser: string;
    via: string[];
    lastAt: string;
    timesSeen: number;
    tracked: boolean;
  }
  const map = new Map<string, Agg>();

  for (const ev of followEvents) {
    if (!ev.targetUser) continue;
    const key = ev.targetUser.toLowerCase();
    const existing = map.get(key);
    if (existing) {
      if (!existing.via.includes(ev.account.username)) existing.via.push(ev.account.username);
      existing.timesSeen += 1;
    } else {
      map.set(key, {
        targetUser: ev.targetUser,
        via: [ev.account.username],
        lastAt: ev.detectedAt.toISOString(),
        timesSeen: 1,
        tracked: trackedLower.has(key),
      });
    }
  }

  const discovered = Array.from(map.values())
    .sort((a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime())
    .slice(0, 30);

  return NextResponse.json(discovered);
}
