"use client";

import { Radar, RefreshCw, Settings, Globe, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/dashboard/theme-toggle";
import { formatCountdown, type ScanStatus, type SettingsView } from "@/lib/types";

interface HeaderProps {
  scanStatus: ScanStatus | null;
  settings: SettingsView | null;
  scanning: boolean;
  onScanNow: () => void;
  onOpenSettings: () => void;
}

/** X-native top bar: brand · live session status · sweep countdown · controls. */
export function Header({ scanStatus, settings, scanning, onScanNow, onOpenSettings }: HeaderProps) {
  const sessionMode = settings?.sessionMode ?? false;
  const alertsOn = settings?.alertsEnabled ?? false;
  const telegramReady = Boolean(settings?.hasTelegramToken && settings?.telegramChatId);
  const running = scanStatus?.state.running ?? false;

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1600px] items-center gap-3 px-4 sm:px-6">
        {/* Logo — radar chip with sweeping beam + live pulse */}
        <div className="relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-primary/10 ring-1 ring-primary/30">
          <span className="radar-sweep absolute inset-0" aria-hidden />
          <Radar className="relative h-5 w-5 text-primary" aria-hidden />
          <span className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#10b981] opacity-60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[#10b981]" />
          </span>
        </div>

        <div className="min-w-0">
          <h1 className="bg-gradient-to-r from-[#1d9bf0] via-sky-400 to-emerald-300 bg-clip-text text-lg font-bold leading-tight tracking-tight text-transparent">
            TweetRadar
          </h1>
          <p className="hidden text-[11px] text-muted-foreground sm:block">
            24/7 X monitoring → instant Telegram alerts
          </p>
        </div>

        {/* Live session status — pulsing dot + label */}
        <div
          className={`ml-2 hidden items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium md:inline-flex ${
            sessionMode
              ? "border-[#10b981]/30 bg-[#10b981]/10 text-[#10b981]"
              : "border-amber-500/30 bg-amber-500/10 text-amber-500"
          }`}
        >
          <span className="relative inline-flex h-2 w-2 text-[#10b981]">
            {sessionMode ? (
              <>
                <span className="live-ping absolute inline-flex h-2 w-2 rounded-full" aria-hidden />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-[#10b981]" aria-hidden />
              </>
            ) : (
              <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" aria-hidden />
            )}
          </span>
          X Session: {sessionMode ? "Active 🟢" : "Profile-only"}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Telegram armed chip */}
          <div
            className={`hidden items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium lg:inline-flex ${
              telegramReady && alertsOn
                ? "border-[#10b981]/30 bg-[#10b981]/10 text-[#10b981]"
                : "border-border bg-secondary text-muted-foreground"
            }`}
          >
            <Zap className="h-3.5 w-3.5" aria-hidden />
            {telegramReady && alertsOn ? "Telegram armed" : "Telegram off"}
          </div>

          {/* Auto-sweep countdown */}
          <div
            className="hidden flex-col items-end rounded-lg border border-border bg-card/60 px-3 py-1.5 sm:flex"
            title="Time until the next automatic sweep"
          >
            <span className="text-[9px] uppercase tracking-widest text-muted-foreground">
              {running ? "Sweep running" : "Next sweep"}
            </span>
            <span className="font-mono text-xs font-semibold text-primary tabular-nums">
              {running ? "in progress…" : formatCountdown(scanStatus?.state.nextScanAt ?? null)}
            </span>
          </div>

          {/* Scan now */}
          <Button
            size="sm"
            variant="outline"
            onClick={onScanNow}
            disabled={scanning}
            className="gap-1.5 border-border bg-card/60 hover:bg-accent hover:text-primary"
            aria-label="Run a scan now"
          >
            <RefreshCw className={`h-4 w-4 ${scanning ? "animate-spin text-primary" : ""}`} aria-hidden />
            <span className="hidden md:inline">Sweep now</span>
          </Button>

          <ThemeToggle />

          <Button
            size="icon"
            onClick={onOpenSettings}
            className="h-9 w-9 bg-primary text-white shadow-[0_0_16px_-6px_rgba(29,155,240,0.8)] hover:bg-[#1a8cd8]"
            aria-label="Open settings"
          >
            <Settings className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </div>

      {/* Compact status strip for narrow screens */}
      <div className="flex items-center gap-3 border-t border-border px-4 py-1.5 text-[11px] text-muted-foreground md:hidden">
        <span className="inline-flex items-center gap-1.5">
          <Globe className="h-3 w-3" aria-hidden />
          {sessionMode ? "Session active" : "Profile-only"}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Zap className="h-3 w-3" aria-hidden />
          {telegramReady && alertsOn ? "Telegram armed" : "Telegram off"}
        </span>
        <span className="ml-auto font-mono tabular-nums">
          {running ? "sweeping…" : `sweep in ${formatCountdown(scanStatus?.state.nextScanAt ?? null)}`}
        </span>
      </div>
    </header>
  );
}
