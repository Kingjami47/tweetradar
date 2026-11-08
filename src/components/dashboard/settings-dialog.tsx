"use client";

import { useEffect, useState } from "react";
import {
  Bot,
  Cookie,
  Loader2,
  LocateFixed,
  Save,
  SendHorizonal,
  ShieldCheck,
  SlidersHorizontal,
  Timer,
  Trash2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import type { SettingsView } from "@/lib/types";

const INTERVALS = [
  { value: "30", label: "Every 30 seconds" },
  { value: "60", label: "Every 1 minute" },
  { value: "120", label: "Every 2 minutes" },
  { value: "300", label: "Every 5 minutes" },
  { value: "600", label: "Every 10 minutes" },
  { value: "900", label: "Every 15 minutes" },
];

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: SettingsView | null;
  onSaved: () => void;
}

export function SettingsDialog({ open, onOpenChange, settings, onSaved }: SettingsDialogProps) {
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [ct0, setCt0] = useState("");
  const [interval, setIntervalSec] = useState("60");
  const [alertsOn, setAlertsOn] = useState(true);
  const [notifyFollows, setNotifyFollows] = useState(true);
  const [notifyPosts, setNotifyPosts] = useState(true);
  const [notifyReplies, setNotifyReplies] = useState(false);
  const [notifyReposts, setNotifyReposts] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const { toast } = useToast();

  // Prefill ONLY when the dialog opens — the dashboard polls settings every 5s
  // and re-running on every poll would wipe whatever the user is typing.
  useEffect(() => {
    if (open && settings) {
      setBotToken(settings.telegramBotToken ?? "");
      setChatId(settings.telegramChatId ?? "");
      setAuthToken(settings.xAuthToken ?? "");
      setCt0(settings.xCt0 ?? "");
      setIntervalSec(String(settings.pollIntervalSec));
      setAlertsOn(settings.alertsEnabled);
      setNotifyFollows(settings.notifyOnFollows);
      setNotifyPosts(settings.notifyOnPosts);
      setNotifyReplies(settings.notifyOnReplies);
      setNotifyReposts(settings.notifyOnReposts);
    }
  }, [open]);

  const collect = () => ({
    telegramBotToken: botToken.trim(),
    telegramChatId: chatId.trim(),
    pollIntervalSec: Number(interval),
    alertsEnabled: alertsOn,
    notifyOnFollows: notifyFollows,
    notifyOnPosts: notifyPosts,
    notifyOnReplies: notifyReplies,
    notifyOnReposts: notifyReposts,
  });

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(collect()),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: "Save failed", description: data.error, variant: "destructive" });
        return;
      }
      toast({ title: "Settings saved", description: "The scheduler picks up the new interval on the next cycle." });
      onSaved();
    } catch {
      toast({ title: "Network error", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const res = await fetch("/api/telegram/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...collect(), persist: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({
          title: "Test alert failed",
          description: data.error,
          variant: "destructive",
        });
        return;
      }
      toast({ title: "Test alert delivered", description: "Check your Telegram chat." });
      onSaved();
    } catch {
      toast({ title: "Network error", variant: "destructive" });
    } finally {
      setTesting(false);
    }
  };

  /** Auto-detect the chat ID from the bot's recent updates — no @userinfobot needed. */
  const detectChat = async () => {
    setDetecting(true);
    try {
      const res = await fetch("/api/telegram/detect-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ telegramBotToken: botToken.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: "Couldn't detect chat ID", description: data.error, variant: "destructive" });
        return;
      }
      setChatId(data.chatId);
      toast({
        title: "Chat ID detected",
        description: `${data.chatId}${data.label ? ` — ${data.label}` : ""}`,
      });
    } catch {
      toast({ title: "Network error", variant: "destructive" });
    } finally {
      setDetecting(false);
    }
  };

  /** Verify the session cookies against X, saving them when valid. */
  const verifySessionCookies = async () => {
    setVerifying(true);
    try {
      // Masked prefill (••••) means "unchanged" — send undefined so the API
      // verifies the STORED cookies instead of failing on the dots.
      const masked = (v: string) => !v.trim() || v.includes("•");
      const res = await fetch("/api/session/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          xAuthToken: masked(authToken) ? undefined : authToken.trim(),
          xCt0: masked(ct0) ? undefined : ct0.trim(),
          persist: !masked(authToken) || !masked(ct0),
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        toast({ title: "Session not accepted", description: data.error, variant: "destructive" });
        return;
      }
      toast({
        title: "X session connected",
        description: data.note,
      });
      onSaved();
    } catch {
      toast({ title: "Network error", variant: "destructive" });
    } finally {
      setVerifying(false);
    }
  };

  const clearSession = async () => {
    setClearing(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ xAuthToken: "", xCt0: "" }),
      });
      if (!res.ok) {
        toast({ title: "Could not clear session", variant: "destructive" });
        return;
      }
      setAuthToken("");
      setCt0("");
      toast({ title: "X session cleared", description: "Monitoring falls back to profile-only mode." });
      onSaved();
    } catch {
      toast({ title: "Network error", variant: "destructive" });
    } finally {
      setClearing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto border-border bg-card text-card-foreground sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-emerald-400" aria-hidden /> Radar settings
          </DialogTitle>
          <DialogDescription>
            Connect a free X session for full timeline tracking, and Telegram for instant alerts.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* X session */}
          <section className="space-y-3" aria-label="X session settings">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-emerald-300">
              <Cookie className="h-4 w-4" aria-hidden /> X session (free timeline reads)
              <span className="ml-auto text-[10px] font-normal uppercase tracking-wider text-muted-foreground">
                {settings?.sessionMode ? "connected" : "not connected"}
              </span>
            </h3>

            <ol className="list-decimal space-y-1 rounded-md border border-border bg-secondary/40 px-4 py-2.5 text-[11px] leading-relaxed text-muted-foreground marker:text-muted-foreground/60">
              <li>
                Log in to X with any account (use a <span className="text-foreground/80">burner</span>) in your browser.
              </li>
              <li>
                Press <span className="text-foreground/80">F12</span> → <span className="text-foreground/80">Application</span> →
                Cookies → <span className="text-foreground/80">https://x.com</span>.
              </li>
              <li>
                Copy the value of <span className="font-mono text-emerald-300">auth_token</span> and paste it below —
                that's all TweetRadar needs. The <span className="font-mono">ct0</span> csrf token is derived
                automatically from x.com.
              </li>
            </ol>

            <div className="space-y-1.5">
              <Label htmlFor="auth-token" className="text-foreground/80">auth_token cookie</Label>
              <Input
                id="auth-token"
                type="password"
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
                placeholder="40-character hex string, e.g. 9f2ac1…"
                autoComplete="off"
                className="border-input bg-secondary/50 font-mono text-sm text-foreground placeholder:text-muted-foreground/60"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ct0-cookie" className="text-foreground/80">
                ct0 cookie <span className="ml-1 text-[10px] font-normal text-muted-foreground">(optional — auto-derived)</span>
              </Label>
              <Input
                id="ct0-cookie"
                type="password"
                value={ct0}
                onChange={(e) => setCt0(e.target.value)}
                placeholder="left empty → fetched fresh from x.com automatically"
                autoComplete="off"
                className="border-input bg-secondary/50 font-mono text-sm text-foreground placeholder:text-muted-foreground/60"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={verifySessionCookies}
                disabled={verifying || saving || clearing}
                className="gap-1.5 bg-[#1d9bf0] text-white hover:bg-[#1a8cd8]"
              >
                {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                Verify &amp; connect
              </Button>
              {settings?.sessionMode && (
                <Button
                  variant="outline"
                  onClick={clearSession}
                  disabled={clearing || verifying}
                  className="gap-1.5 border-border bg-secondary text-foreground hover:bg-accent hover:text-[#f43f5e]"
                >
                  {clearing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  Disconnect
                </Button>
              )}
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              The radar uses these cookies the same way your browser does — reading the public
              timelines of the accounts you watch. <span className="text-muted-foreground">100% free, no X
              developer account</span>. Cookies expire only when the account logs out or X rotates
              them; if monitoring stops, paste fresh ones.
            </p>
          </section>

          <Separator className="bg-border" />

          {/* Telegram */}
          <section className="space-y-3" aria-label="Telegram settings">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-emerald-300">
              <SendHorizonal className="h-4 w-4" aria-hidden /> Telegram alerts
            </h3>
            <div className="space-y-1.5">
              <Label htmlFor="bot-token" className="text-foreground/80">Bot token</Label>
              <Input
                id="bot-token"
                type="password"
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder="123456789:AAE...from @BotFather"
                className="border-input bg-secondary/50 font-mono text-sm text-foreground placeholder:text-muted-foreground/60"
              />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="chat-id" className="text-foreground/80">Chat ID</Label>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={detectChat}
                  disabled={detecting || saving || testing || (!botToken.trim() && !settings?.hasTelegramToken)}
                  className="h-7 gap-1.5 border-border bg-secondary px-2.5 text-[11px] text-foreground hover:bg-accent hover:text-[#10b981]"
                >
                  {detecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LocateFixed className="h-3.5 w-3.5" />}
                  Detect
                </Button>
              </div>
              <Input
                id="chat-id"
                value={chatId}
                onChange={(e) => setChatId(e.target.value)}
                placeholder="press Detect after messaging your bot, or paste e.g. 987654321"
                className="border-input bg-secondary/50 font-mono text-sm text-foreground placeholder:text-muted-foreground/60"
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Paste the token from <span className="text-emerald-300">@BotFather</span>, open your
                bot in Telegram and press <span className="text-emerald-300">Start</span> — your chat
                ID is then detected automatically (or hit <span className="text-emerald-300">Detect</span>).
                For a group/channel: add the bot there, post once, Detect again.
                Press <span className="text-emerald-300">&ldquo;Test Telegram&rdquo;</span> to verify &amp; save.
              </p>
            </div>
            <p className="rounded-md border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-2 text-[11px] leading-relaxed text-emerald-200/90">
              💡 This bot is <b>two-way</b>: once connected, send it{" "}
              <span className="font-mono">+ @username</span> (or{" "}
              <span className="font-mono">add @u1 @u2 @u3 …</span>) right in Telegram to watch
              accounts without opening the dashboard — <span className="font-mono">/list</span>{" "}
              shows everything on the radar.
            </p>
          </section>

          <Separator className="bg-border" />

          {/* Notification scope — high-signal Telegram routing */}
          <section className="space-y-3" aria-label="Notification scope settings">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-emerald-300">
              <SlidersHorizontal className="h-4 w-4" aria-hidden /> Notification scope
            </h3>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Telegram only pings for <span className="text-foreground/80">high-signal actions</span>.
              Everything else still lands on the dashboard — it just stays quiet.
            </p>
            <div className="divide-y divide-border rounded-md border border-border bg-secondary/40">
              {(
                [
                  {
                    key: "follows",
                    label: "New follows",
                    hint: "🚨 “@target just followed:” — batched digest",
                    checked: notifyFollows,
                    set: setNotifyFollows,
                  },
                  {
                    key: "posts",
                    label: "Original posts",
                    hint: "📝 “@target just posted:” — quotes count as posts",
                    checked: notifyPosts,
                    set: setNotifyPosts,
                  },
                  {
                    key: "replies",
                    label: "Replies",
                    hint: "💬 responses to other accounts — dashboard only by default",
                    checked: notifyReplies,
                    set: setNotifyReplies,
                  },
                  {
                    key: "reposts",
                    label: "Reposts",
                    hint: "🔁 amplified content from others — dashboard only by default",
                    checked: notifyReposts,
                    set: setNotifyReposts,
                  },
                ] as const
              ).map((row) => (
                <div key={row.key} className="flex items-center justify-between gap-4 px-3 py-2.5">
                  <div>
                    <Label htmlFor={`notify-${row.key}`} className="text-foreground">{row.label}</Label>
                    <p className="text-[11px] text-muted-foreground">{row.hint}</p>
                  </div>
                  <Switch
                    id={`notify-${row.key}`}
                    checked={row.checked}
                    onCheckedChange={row.set}
                    aria-label={`Toggle Telegram alerts for ${row.label}`}
                  />
                </div>
              ))}
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Profile edits (bio / display name / follower swings) always stay dashboard-only.
            </p>
          </section>

          <Separator className="bg-border" />

          {/* Scheduling */}
          <section className="space-y-3" aria-label="Scheduling settings">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-emerald-300">
              <Timer className="h-4 w-4" aria-hidden /> Sweep schedule
            </h3>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="interval" className="text-foreground/80">Scan interval</Label>
              <Select value={interval} onValueChange={setIntervalSec}>
                <SelectTrigger id="interval" className="w-52 border-input bg-secondary/50 text-foreground">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-border bg-popover text-popover-foreground">
                  {INTERVALS.map((i) => (
                    <SelectItem key={i.value} value={i.value}>{i.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="alerts-switch" className="text-foreground/80">Telegram alerts</Label>
                <p className="text-[11px] text-muted-foreground">Master switch for outbound pings</p>
              </div>
              <Switch
                id="alerts-switch"
                checked={alertsOn}
                onCheckedChange={setAlertsOn}
                aria-label="Toggle Telegram alerts"
              />
            </div>
          </section>
        </div>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            onClick={sendTest}
            disabled={testing || saving}
            className="gap-1.5 border-border bg-secondary hover:bg-accent hover:text-amber-500"
          >
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <SendHorizonal className="h-4 w-4" />}
            Test Telegram
          </Button>
          <Button
            onClick={save}
            disabled={saving || testing}
            className="gap-1.5 bg-[#1d9bf0] text-white hover:bg-[#1a8cd8]"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save settings
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
