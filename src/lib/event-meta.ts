import type { EventType } from "@/lib/types";

/**
 * Command-center event styling. `badge` is the X-native pill label shown on
 * feed cards (🚨 NEW FOLLOW / 📝 POST / 💬 REPLY …).
 * Palette roles: X Blue = posts/content · Emerald = follows/live ·
 * Rose = unfollows/alerts · Amber = replies · Violet = quotes · Sky = profile.
 */
export const EVENT_META: Record<
  EventType,
  { label: string; badge: string; color: string; bg: string; border: string }
> = {
  POST:    { label: "Post",   badge: "📝 POST",        color: "text-[#1d9bf0]",   bg: "bg-[#1d9bf0]/10",   border: "border-[#1d9bf0]/30" },
  REPOST:  { label: "Repost", badge: "🔁 REPOST",      color: "text-teal-500",    bg: "bg-teal-500/10",    border: "border-teal-500/30" },
  REPLY:   { label: "Reply",  badge: "💬 REPLY",       color: "text-amber-500",   bg: "bg-amber-500/10",   border: "border-amber-500/30" },
  QUOTE:   { label: "Quote",  badge: "🗒 QUOTE",       color: "text-violet-500",  bg: "bg-violet-500/10",  border: "border-violet-500/30" },
  LIKE:    { label: "Like",   badge: "❤️ LIKE",        color: "text-[#f43f5e]",   bg: "bg-[#f43f5e]/10",   border: "border-[#f43f5e]/30" },
  FOLLOW:  { label: "Follow", badge: "🚨 NEW FOLLOW",  color: "text-[#10b981]",   bg: "bg-[#10b981]/10",   border: "border-[#10b981]/30" },
  PROFILE: { label: "Profile",badge: "🟣 PROFILE EDIT",color: "text-sky-500",     bg: "bg-sky-500/10",     border: "border-sky-500/30" },
};

export const TRACK_OPTIONS: {
  key: "trackPosts" | "trackReplies" | "trackReposts" | "trackLikes" | "trackFollows";
  type: EventType;
  hint: string;
}[] = [
  { key: "trackPosts",   type: "POST",   hint: "New posts & threads" },
  { key: "trackReplies", type: "REPLY",  hint: "Replies to others" },
  { key: "trackReposts", type: "REPOST", hint: "Retweets & boosts" },
  { key: "trackLikes",   type: "LIKE",   hint: "Liked posts" },
  { key: "trackFollows", type: "FOLLOW", hint: "Who they start following" },
];
