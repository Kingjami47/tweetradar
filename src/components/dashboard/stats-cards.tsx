"use client";

import { Activity, BellRing, Users, Timer } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { timeAgo, type ScanStatus, type SettingsView } from "@/lib/types";

interface StatsCardsProps {
  scanStatus: ScanStatus | null;
  settings: SettingsView | null;
}

/**
 * Metrics strip — the four command-center KPIs:
 * watched handles · events detected today · telegram status · last check age.
 */
export function StatsCards({ scanStatus, settings }: StatsCardsProps) {
  const stats = scanStatus?.stats;
  const telegramReady = Boolean(settings?.hasTelegramToken && settings?.telegramChatId);
  const telegramArmed = telegramReady && (settings?.alertsEnabled ?? false);

  const items = [
    {
      icon: Users,
      label: "Total Watched Handles",
      value: stats ? String(stats.totalAccounts) : "—",
      hint: stats ? `${stats.activeAccounts} active · ${stats.totalAccounts - stats.activeAccounts} paused` : "waiting for data",
      accent: "text-[#1d9bf0] bg-[#1d9bf0]/10 ring-[#1d9bf0]/25",
      glow: "via-[#1d9bf0]/60",
    },
    {
      icon: Activity,
      label: "Events Detected Today",
      value: stats ? String(stats.today) : "—",
      hint: stats ? `${stats.last24h} in the last 24h` : "waiting for data",
      accent: "text-[#10b981] bg-[#10b981]/10 ring-[#10b981]/25",
      glow: "via-[#10b981]/60",
    },
    {
      icon: BellRing,
      label: "Telegram Status",
      value: telegramArmed ? "Armed 🟢" : telegramReady ? "Muted" : "Offline",
      hint: telegramReady ? "alerts routed to your chat" : "connect a bot in Settings",
      accent: telegramArmed
        ? "text-[#10b981] bg-[#10b981]/10 ring-[#10b981]/25"
        : "text-[#f43f5e] bg-[#f43f5e]/10 ring-[#f43f5e]/25",
      glow: telegramArmed ? "via-[#10b981]/60" : "via-[#f43f5e]/60",
    },
    {
      icon: Timer,
      label: "Time Since Last Check",
      value: scanStatus?.state.lastScanAt ? timeAgo(scanStatus.state.lastScanAt) : "—",
      hint: scanStatus?.state.lastStatus
        ? `last sweep: ${scanStatus.state.lastStatus}`
        : "waiting for first sweep",
      accent: "text-violet-500 bg-violet-500/10 ring-violet-500/25",
      glow: "via-violet-500/60",
    },
  ];

  return (
    <section aria-label="Command center metrics" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      {items.map((item) => (
        <Card
          key={item.label}
          className="panel group relative overflow-hidden rounded-xl border-border transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/30"
        >
          {/* colored sheen on the top edge */}
          <div
            className={`absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent ${item.glow} to-transparent opacity-70`}
            aria-hidden
          />
          <CardContent className="flex items-center gap-3 p-4">
            <div
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ring-1 transition-transform duration-200 group-hover:scale-105 ${item.accent}`}
            >
              <item.icon className="h-5 w-5" aria-hidden />
            </div>
            <div className="min-w-0">
              <div className="truncate text-xl font-bold leading-tight tracking-tight text-foreground tabular-nums">
                {item.value}
              </div>
              <div className="truncate text-xs font-medium text-foreground/80">{item.label}</div>
              <div className="truncate text-[11px] text-muted-foreground">{item.hint}</div>
            </div>
          </CardContent>
        </Card>
      ))}
    </section>
  );
}
