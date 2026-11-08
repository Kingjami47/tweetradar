/**
 * Keyless X data via the public FixTweet API (api.fxtwitter.com).
 *
 * IMPORTANT SCOPE NOTE:
 * The X API free tier is write-only — timeline reads (GET /2/users/:id/tweets)
 * require Basic tier. X's own syndication/embed endpoints are IP-rate-limited
 * from server environments. FixTweet's user endpoint is the one reliable
 * keyless source here: it returns the REAL profile of any public account
 * (id, name, bio, follower/following/post counts, verification).
 *
 * What this enables without any token:
 *   - real account identity sync (id, display name, bio)
 *   - real follower-count / bio change detection between sweeps
 * What still needs an X API bearer token:
 *   - posts, replies, quotes, reposts, likes, follow-graph monitoring
 */

const FX_BASE = "https://api.fxtwitter.com";

export interface KeylessProfile {
  ok: boolean;
  /** Real X user id (snowflake), e.g. "1388477070523572227" */
  id?: string;
  screenName?: string;
  name?: string;
  description?: string;
  followers?: number;
  following?: number;
  tweetCount?: number;
  avatarUrl?: string;
  verified?: boolean;
  protected?: boolean;
  /** "not_found" | "rate_limited" | "network" | "parse" */
  errorKind?: "not_found" | "rate_limited" | "network" | "parse";
  error?: string;
}

interface FxUserResponse {
  code?: number;
  message?: string;
  user?: {
    id?: string;
    screen_name?: string;
    name?: string;
    description?: string;
    followers?: number;
    following?: number;
    tweets?: number;
    avatar_url?: string;
    verification?: { verified?: boolean } | null;
    protected?: boolean;
  };
}

/** Fetch the real, current profile of a public X account — no API key needed. */
export async function fetchProfileKeyless(username: string): Promise<KeylessProfile> {
  const clean = username.trim().replace(/^@/, "");
  try {
    const res = await fetch(`${FX_BASE}/${encodeURIComponent(clean)}`, {
      headers: {
        "User-Agent": "TweetRadar/1.0 (profile monitor)",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });

    if (res.status === 404) {
      return { ok: false, errorKind: "not_found", error: `@${clean} does not exist on X` };
    }
    if (res.status === 429) {
      return { ok: false, errorKind: "rate_limited", error: "keyless source rate-limited — will retry next sweep" };
    }

    const data = (await res.json().catch(() => null)) as FxUserResponse | null;
    if (!res.ok || !data?.user?.id) {
      return {
        ok: false,
        errorKind: res.status === 403 ? "rate_limited" : "parse",
        error: data?.message ?? `FixTweet HTTP ${res.status}`,
      };
    }

    return {
      ok: true,
      id: data.user.id,
      screenName: data.user.screen_name ?? clean,
      name: data.user.name ?? undefined,
      description: data.user.description ?? "",
      followers: data.user.followers,
      following: data.user.following,
      tweetCount: data.user.tweets,
      avatarUrl: data.user.avatar_url,
      verified: data.user.verification?.verified ?? false,
      protected: data.user.protected,
    };
  } catch (err) {
    return {
      ok: false,
      errorKind: "network",
      error: err instanceof Error ? err.message : "network error",
    };
  }
}
