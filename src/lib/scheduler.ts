/**
 * Background scheduler: runs the scan engine on a loop.
 * The interval is re-read from Settings every cycle, so changing the poll
 * interval in the UI takes effect on the next cycle.
 */

import { runScan, isScanning } from "@/lib/monitor";

interface SchedulerState {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  lastScanAt: Date | null;
  lastStatus: string | null;
  nextScanAt: Date | null;
  startedAt: Date | null;
}

const globalForScheduler = globalThis as unknown as {
  tweetRadarScheduler: SchedulerState | undefined;
};

const state: SchedulerState =
  globalForScheduler.tweetRadarScheduler ?? {
    timer: null,
    running: false,
    lastScanAt: null,
    lastStatus: null,
    nextScanAt: null,
    startedAt: null,
  };
globalForScheduler.tweetRadarScheduler = state;

async function cycle() {
  state.running = true;
  try {
    const { getSettings } = await import("@/lib/settings");
    const settings = await getSettings();
    const result = await runScan("auto");
    state.lastScanAt = new Date();
    state.lastStatus = result.status;
    state.nextScanAt = new Date(Date.now() + settings.pollIntervalSec * 1000);
  } catch (err) {
    state.lastStatus = "error";
    state.nextScanAt = new Date(Date.now() + 60_000);
    console.error("[TweetRadar] scan cycle failed:", err instanceof Error ? err.message : err);
  } finally {
    state.running = false;
    // Continue the loop with the (possibly updated) interval
    if (state.startedAt) scheduleNext();
  }
}

function scheduleNext() {
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(async () => {
    if (isScanning()) {
      scheduleNext();
      return;
    }
    await cycle();
  }, delayMs());
}

function delayMs(): number {
  // The real interval is read inside cycle(); this just keeps the loop ticking.
  // If nextScanAt is known and in the future, wait for it; otherwise ~15s tick.
  if (state.nextScanAt) {
    const ms = state.nextScanAt.getTime() - Date.now();
    if (ms > 2000) return ms;
  }
  return 15_000;
}

/** Idempotently start the scheduler. Called from instrumentation. */
export function startScheduler() {
  if (state.startedAt) return;
  state.startedAt = new Date();
  state.nextScanAt = new Date(Date.now() + 8_000);
  state.timer = setTimeout(() => void cycle(), 8_000);
  console.log("[TweetRadar] scheduler started — first scan in 8s");
  // Orphan cleanup: a scan that was in flight when the server died or was
  // restarted leaves a "running" row behind forever, which can wedge the UI
  // in a perpetual sweep state. Close every orphan out at boot.
  void (async () => {
    try {
      const { db } = await import("@/lib/db");
      const orphans = await db.scanLog.updateMany({
        where: { status: "running" },
        data: {
          status: "error",
          finishedAt: new Date(),
          message: "aborted — server restarted mid-scan",
        },
      });
      if (orphans.count > 0) {
        console.log(`[TweetRadar] closed ${orphans.count} orphaned "running" scan row(s) at boot`);
      }
    } catch (err) {
      console.error(
        "[TweetRadar] orphan scan-log cleanup failed:",
        err instanceof Error ? err.message : err
      );
    }
  })();
}

export function getSchedulerState(): {
  running: boolean;
  lastScanAt: string | null;
  lastStatus: string | null;
  nextScanAt: string | null;
  startedAt: string | null;
} {
  return {
    running: state.running || isScanning(),
    lastScanAt: state.lastScanAt ? state.lastScanAt.toISOString() : null,
    lastStatus: state.lastStatus,
    nextScanAt: state.nextScanAt ? state.nextScanAt.toISOString() : null,
    startedAt: state.startedAt ? state.startedAt.toISOString() : null,
  };
}
