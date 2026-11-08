"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Header } from "@/components/dashboard/header";
import { StatsCards } from "@/components/dashboard/stats-cards";
import { AddAccountCard } from "@/components/dashboard/add-account-card";
import { Watchlist } from "@/components/dashboard/watchlist";
import { SmartCircle } from "@/components/dashboard/smart-circle";
import { ActivityFeed } from "@/components/dashboard/activity-feed";
import { SettingsDialog } from "@/components/dashboard/settings-dialog";
import { Moon, Radar } from "lucide-react";
import type { ActivityItem, DiscoveredItem, ScanStatus, SettingsView, WatchAccount } from "@/lib/types";

const POLL_MS = 5000;

export default function Home() {
  const [accounts, setAccounts] = useState<WatchAccount[]>([]);
  const [events, setEvents] = useState<ActivityItem[]>([]);
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredItem[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  // In-flight guard: the 5s interval must never stack slow refreshes — an
  // older slow response landing after a newer one would overwrite fresh
  // state with stale data.
  const refreshingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      const [accRes, evRes, scanRes, setRes, discRes] = await Promise.all([
        fetch("/api/accounts"),
        fetch("/api/events?limit=80"),
        fetch("/api/scan"),
        fetch("/api/settings"),
        fetch("/api/discovered"),
      ]);
      if (accRes.ok) setAccounts(await accRes.json());
      if (evRes.ok) setEvents(await evRes.json());
      if (scanRes.ok) setScanStatus(await scanRes.json());
      if (setRes.ok) setSettings(await setRes.json());
      if (discRes.ok) setDiscovered(await discRes.json());
    } catch {
      // transient network hiccup — next poll will retry
    } finally {
      refreshingRef.current = false;
    }
  }, []);

  // Initial load + polling loop
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const scanNow = async () => {
    setScanning(true);
    try {
      const res = await fetch("/api/scan", { method: "POST" });
      if (res.ok) await refresh();
    } catch {
      // network hiccup — the 5s polling loop and the next sweep self-heal
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="cc-canvas relative flex min-h-screen flex-col text-foreground">
      {/* Tactical grid overlay (purely decorative) */}
      <div className="cc-grid-overlay pointer-events-none absolute inset-x-0 top-0 h-[420px]" aria-hidden />

      <Header
        scanStatus={scanStatus}
        settings={settings}
        scanning={scanning}
        onScanNow={scanNow}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main className="relative mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 sm:px-6">
        {/* Session status banner */}
        {settings && !settings.sessionMode && (
          <div
            className="mb-4 flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-3.5 text-sm"
            role="status"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 ring-1 ring-amber-500/25">
              <Moon className="h-3.5 w-3.5 text-amber-500" aria-hidden />
            </span>
            <p className="text-foreground/80">
              <span className="font-semibold text-amber-500">Profile-only monitoring</span> — follower
              swings and bio edits are detected against live X data every sweep. To track{" "}
              <span className="font-semibold">posts, replies, quotes and reposts</span> for free, paste
              the <span className="font-mono">auth_token</span> and <span className="font-mono">ct0</span>{" "}
              cookies from any logged-in X account (a burner works best) in{" "}
              <button onClick={() => setSettingsOpen(true)} className="underline decoration-amber-500/50 underline-offset-2 hover:text-primary">Settings → X session</button>.
              The radar then reads timelines exactly like x.com&rsquo;s own browser does — no API key, no
              developer account, $0/month.
            </p>
          </div>
        )}

        {/* No Telegram yet */}
        {settings && (!settings.hasTelegramToken || !settings.telegramChatId) && (
          <div className="mb-4 flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-3.5 text-sm" role="status">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 ring-1 ring-amber-500/25">
              <Radar className="h-3.5 w-3.5 text-amber-500" aria-hidden />
            </span>
            <p className="text-foreground/80">
              <span className="font-semibold text-amber-500">Telegram not connected</span> — add your
              bot token and chat ID in{" "}
              <button onClick={() => setSettingsOpen(true)} className="underline decoration-amber-500/50 underline-offset-2 hover:text-primary">
                Settings
              </button>{" "}
              to receive alerts the moment watched accounts post, repost or follow.
            </p>
          </div>
        )}

        <StatsCards scanStatus={scanStatus} settings={settings} />

        {/* Split workspace: 30% watchlist sidebar · 70% live feed */}
        <div className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(320px,30%)_minmax(0,1fr)]">
          <div className="flex flex-col gap-4">
            <AddAccountCard onAdded={refresh} />
            <Watchlist accounts={accounts} onChanged={refresh} />
            <SmartCircle items={discovered} onChanged={refresh} />
          </div>
          <div className="lg:sticky lg:top-20">
            <ActivityFeed events={events} loading={scanStatus?.state.running ?? false} />
          </div>
        </div>
      </main>

      <footer className="relative mt-auto border-t border-border bg-card/60">
        <div className="mx-auto flex max-w-[1600px] flex-col items-center justify-between gap-1 px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-xs text-muted-foreground sm:flex-row sm:px-6">
          <span className="inline-flex items-center gap-1.5">
            <Radar className="h-3.5 w-3.5 text-[#10b981]" aria-hidden />
            TweetRadar — 24/7 X monitoring with instant Telegram alerts
          </span>
          <span>
            Scheduler {scanStatus?.state.startedAt ? "running" : "starting"} · polls every{" "}
            {settings?.pollIntervalSec ?? 60}s
          </span>
        </div>
      </footer>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        onSaved={refresh}
      />
    </div>
  );
}
