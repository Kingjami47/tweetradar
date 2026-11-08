/**
 * Twitter/X API v2 client (live mode).
 * Requires a Bearer Token (App-only) set in Settings.
 * Docs: https://developer.x.com/en/docs/twitter-api
 */

const API_BASE = "https://api.twitter.com/2";

export interface TwitterUser {
  id: string;
  username: string;
  name: string;
  description?: string;
  profile_image_url?: string;
  public_metrics?: { followers_count?: number; following_count?: number; tweet_count?: number };
}

export interface ClassifiedTweet {
  id: string;
  type: "POST" | "REPOST" | "REPLY" | "QUOTE";
  text: string;
  url: string;
  createdAt: string;
  targetUser?: string;
  metrics: { likes: number; retweets: number; replies: number; views: number };
}

interface ApiTweet {
  id: string;
  text: string;
  created_at?: string;
  author_id?: string;
  in_reply_to_user_id?: string;
  referenced_tweets?: { type: string; id: string }[];
  public_metrics?: { like_count?: number; retweet_count?: number; reply_count?: number };
  entities?: { urls?: { url: string; expanded_url: string }[] };
}

interface Includes {
  tweets?: { id: string; author_id?: string }[];
  users?: { id: string; username: string }[];
}

async function apiGet<T>(path: string, bearer: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${API_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => null)) as
    | { data?: unknown; errors?: { title?: string; detail?: string }[]; title?: string; detail?: string }
    | null;
  if (!res.ok) {
    const msg = data?.errors?.[0]?.detail || data?.detail || data?.title || `Twitter API HTTP ${res.status}`;
    throw new Error(msg);
  }
  return (data?.data ?? data) as T;
}

/** Resolve a username to a full user object. Throws if not found / auth failure. */
export async function resolveUser(username: string, bearer: string): Promise<TwitterUser> {
  return apiGet<TwitterUser>(
    `/users/by/username/${encodeURIComponent(username)}`,
    bearer,
    { "user.fields": "description,profile_image_url,public_metrics" }
  );
}

/**
 * Canonical, always-resolving URL for a tweet:
 * - POST / REPLY / QUOTE → https://x.com/{author}/status/{tweetId}
 * - REPOST → the ORIGINAL post (retweet wrapper IDs open an interstitial,
 *   the original is what the user wants to read). We resolve the original
 *   author via expansions when possible; x.com/i/status/{id} is the universal
 *   fallback redirector.
 */
function buildTweetUrl(tweetId: string, authorUsername: string | undefined, refType?: string, refId?: string, refAuthorUsername?: string): string {
  if (refType === "retweeted" && refId) {
    return refAuthorUsername
      ? `https://x.com/${refAuthorUsername}/status/${refId}`
      : `https://x.com/i/status/${refId}`;
  }
  return authorUsername
    ? `https://x.com/${authorUsername}/status/${tweetId}`
    : `https://x.com/i/status/${tweetId}`;
}

/**
 * Fetch the user's recent timeline and classify each tweet.
 * `excludes=replies` is NOT used so replies come through and can be classified.
 * `expansions=referenced_tweets.id` + `user.fields=username` lets us link
 * reposts to the original post's canonical URL.
 */
export async function fetchUserTimeline(
  userId: string,
  bearer: string,
  sinceId?: string | null,
  username?: string
): Promise<ClassifiedTweet[]> {
  const params: Record<string, string> = {
    max_results: "20",
    "tweet.fields": "created_at,public_metrics,referenced_tweets,in_reply_to_user_id,entities,author_id",
    expansions: "referenced_tweets.id",
    "user.fields": "username",
  };
  if (sinceId) params.since_id = sinceId;

  const url = new URL(`${API_BASE}/users/${userId}/tweets`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await res.json().catch(() => null)) as
    | { data?: ApiTweet[]; includes?: Includes; errors?: { title?: string; detail?: string }[]; title?: string; detail?: string }
    | null;
  if (!res.ok) {
    const msg = payload?.errors?.[0]?.detail || payload?.detail || payload?.title || `Twitter API HTTP ${res.status}`;
    throw new Error(msg);
  }

  const tweets = payload?.data;
  if (!Array.isArray(tweets)) return [];

  // Maps to resolve referenced (original) tweets and their authors
  const userById = new Map<string, string>();
  payload?.includes?.users?.forEach((u) => userById.set(u.id, u.username));
  const tweetAuthorById = new Map<string, string | undefined>();
  payload?.includes?.tweets?.forEach((t) => {
    if (t.author_id) tweetAuthorById.set(t.id, userById.get(t.author_id));
  });

  return tweets.map((t) => {
    const ref = t.referenced_tweets?.[0];
    const refType = ref?.type;
    let type: ClassifiedTweet["type"] = "POST";
    if (refType === "retweeted") type = "REPOST";
    else if (refType === "quoted") type = "QUOTE";
    else if (t.in_reply_to_user_id) type = "REPLY";

    const refAuthor = ref?.id ? tweetAuthorById.get(ref.id) : undefined;

    return {
      id: t.id,
      type,
      text: t.text,
      url: buildTweetUrl(t.id, username ?? userById.get(t.author_id ?? ""), refType, ref?.id, refAuthor),
      createdAt: t.created_at ?? new Date().toISOString(),
      metrics: {
        likes: t.public_metrics?.like_count ?? 0,
        retweets: t.public_metrics?.retweet_count ?? 0,
        replies: t.public_metrics?.reply_count ?? 0,
        views: 0,
      },
    };
  });
}

/**
 * Fetch accounts the user recently followed.
 * NOTE: requires Elevated/Pro API access. Throws with the API message on 403.
 */
export async function fetchUserFollowing(
  userId: string,
  bearer: string
): Promise<{ id: string; username: string; name: string }[]> {
  return apiGet<{ id: string; username: string; name: string }[]>(
    `/users/${userId}/following`,
    bearer,
    { max_results: "20", "user.fields": "id,username,name" }
  );
}
