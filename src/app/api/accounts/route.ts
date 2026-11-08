import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { addWatchedAccount } from "@/lib/accounts";
import { runScan } from "@/lib/monitor";

export async function GET() {
  const accounts = await db.watchedAccount.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { events: true } },
      events: { orderBy: { detectedAt: "desc" }, take: 1, select: { detectedAt: true, type: true } },
    },
  });

  return NextResponse.json(
    accounts.map((a) => ({
      id: a.id,
      username: a.username,
      displayName: a.displayName,
      avatarColor: a.avatarColor,
      bio: a.bio,
      active: a.active,
      trackPosts: a.trackPosts,
      trackReplies: a.trackReplies,
      trackReposts: a.trackReposts,
      trackLikes: a.trackLikes,
      trackFollows: a.trackFollows,
      eventCount: a._count.events,
      followersCount: a.followersCount,
      lastEventAt: a.events[0]?.detectedAt ?? null,
      lastScanAt: a.lastScanAt,
      createdAt: a.createdAt,
    }))
  );
}

export async function POST(req: NextRequest) {
  let body: {
    username?: string;
    trackPosts?: boolean;
    trackReplies?: boolean;
    trackReposts?: boolean;
    trackLikes?: boolean;
    trackFollows?: boolean;
    notes?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const outcome = await addWatchedAccount(body.username ?? "", {
    tracks: {
      trackPosts: body.trackPosts,
      trackReplies: body.trackReplies,
      trackReposts: body.trackReposts,
      trackLikes: body.trackLikes,
      trackFollows: body.trackFollows,
    },
    notes: body.notes,
  });

  if (!outcome.ok) {
    const status =
      outcome.errorKind === "invalid"
        ? 400
        : outcome.errorKind === "conflict" || outcome.alreadyTracked
          ? 409
          : outcome.errorKind === "not_found"
            ? 404
            : 503;
    return NextResponse.json({ error: outcome.error }, { status });
  }

  const account = await db.watchedAccount.findUnique({ where: { id: outcome.accountId! } });
  if (!account) {
    return NextResponse.json({ error: "Account vanished after creation" }, { status: 500 });
  }

  // Kick an immediate background sweep so the first real activity lands fast
  void runScan("manual").catch(() => undefined);

  return NextResponse.json(account, { status: 201 });
}
