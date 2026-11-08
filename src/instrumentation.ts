/**
 * Next.js instrumentation hook — boots the TweetRadar scheduler and the
 * Telegram command poller once per server process (nodejs runtime only).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Boot marker — bump the version whenever alert formats / bot behavior
    // change. dev.log showing an older version means the process is running
    // STALE code and must be restarted (instrumentation only runs at boot).
    console.log("[TweetRadar] boot — alert format v12 (anonymous bot: public command menu + description wiped across every scope, strangers get total silence, guard confirmations & reports only in the owner's DM, owner /guard messages wiped from the protected chat)");
    const { startScheduler } = await import("@/lib/scheduler");
    startScheduler();
    const { startTelegramCommandPoller } = await import("@/lib/telegram-commands");
    startTelegramCommandPoller();
  }
}
