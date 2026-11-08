import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runScan } from "@/lib/monitor";
import { getSchedulerState } from "@/lib/scheduler";

/** Scheduler status + recent scan logs. */
export async function GET() {
  const state = getSchedulerState();
  const recentLogs = await db.scanLog.findMany({
    orderBy: { startedAt: "desc" },
    take: 8,
  });
  // Local-midnight boundary for the "Events detected today" stat card.
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const alertStats = {
    last24h: await db.activityEvent.count({ where: { detectedAt: { gte: new Date(Date.now() - 24 * 3600_000) } } }),
    today: await db.activityEvent.count({ where: { detectedAt: { gte: todayStart } } }),
    notified: await db.activityEvent.count({ where: { notified: true } }),
    totalAccounts: await db.watchedAccount.count(),
    activeAccounts: await db.watchedAccount.count({ where: { active: true } }),
  };
  return NextResponse.json({ state, recentLogs, stats: alertStats });
}

/**
 * Manually trigger a scan cycle. Body (optional): { accountId } — sweeps just
 * that one watched account (the sidebar's per-account "Sweep" button).
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { accountId?: string };
    // Validate the per-account sweep target up front — an unknown id would
    // otherwise create a bogus "success" ScanLog with accountsChecked=0.
    if (body.accountId) {
      const exists = await db.watchedAccount.findUnique({
        where: { id: body.accountId },
        select: { id: true },
      });
      if (!exists) {
        return NextResponse.json({ error: "Unknown accountId" }, { status: 404 });
      }
    }
    const result = await runScan("manual", body.accountId);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Scan failed" },
      { status: 500 }
    );
  }
}
