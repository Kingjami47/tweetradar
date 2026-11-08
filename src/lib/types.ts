export type EventType = "POST" | "REPOST" | "REPLY" | "QUOTE" | "LIKE" | "FOLLOW" | "PROFILE";

export interface WatchAccount {
  id: string;
  username: string;
  displayName: string | null;
  avatarColor: string | null;
  bio: string | null;
  active: boolean;
  trackPosts: boolean;
  trackReplies: boolean;
  trackReposts: boolean;
  trackLikes: boolean;
  trackFollows: boolean;
  eventCount: number;
  followersCount: number | null;
  lastEventAt: string | null;
  lastScanAt: string | null;
  createdAt: string;
}

export interface ActivityItem {
  id: string;
  type: EventType;
  text: string | null;
  url: string | null;
  targetUser: string | null;
  metrics: { likes?: number; retweets?: number; replies?: number; views?: number; followers?: number } | null;
  notified: boolean;
  detectedAt: string;
  account: { username: string; displayName: string | null; avatarColor: string | null };
}

/** An account one of the watched accounts recently started following. */
export interface DiscoveredItem {
  targetUser: string;
  via: string[];
  lastAt: string;
  timesSeen: number;
  tracked: boolean;
}

export interface ScanLogView {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  trigger: string;
  mode: string;
  accountsChecked: number;
  eventsFound: number;
  alertsSent: number;
  message: string | null;
}

export interface ScanStatus {
  state: {
    running: boolean;
    lastScanAt: string | null;
    lastStatus: string | null;
    nextScanAt: string | null;
    startedAt: string | null;
  };
  recentLogs: ScanLogView[];
  stats: {
    last24h: number;
    today: number;
    notified: number;
    totalAccounts: number;
    activeAccounts: number;
  };
}

export interface SettingsView {
  telegramBotToken: string | null;
  telegramChatId: string | null;
  xAuthToken: string | null;
  xCt0: string | null;
  pollIntervalSec: number;
  alertsEnabled: boolean;
  notifyOnFollows: boolean;
  notifyOnPosts: boolean;
  notifyOnReplies: boolean;
  notifyOnReposts: boolean;
  hasTelegramToken: boolean;
  hasSession: boolean;
  sessionMode: boolean;
}

/** Compact relative-time formatter, e.g. "just now", "4m ago", "3h ago". */
export function timeAgo(iso: string | Date): string {
  const date = typeof iso === "string" ? new Date(iso) : iso;
  const diff = Date.now() - date.getTime();
  if (diff < 15_000) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function formatCountdown(iso: string | null): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "any moment";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** X-style compact counts: 4,081,045 → "4.1M", 94,761 → "94.7K", 938 → "938". */
export function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}
