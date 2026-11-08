/**
 * X web-client GraphQL client — 100% free timeline reads, no developer portal.
 *
 * This talks to the SAME endpoints x.com's own frontend uses:
 *   GET https://x.com/i/api/graphql/{queryId}/{Operation}
 * Auth = the static public web bearer (used by every logged-in browser) +
 * a burner account's session cookies (auth_token + ct0). No API key, no billing.
 *
 * Hardening handled here (all learned empirically, mirror of RSSHub's approach):
 *  1. QueryIds rotate → each op has a candidate list; a dead id answers 404
 *     and the client auto-falls through and caches the winner.
 *  2. Protected ops (UserTweetsAndReplies, SearchTimeline) REQUIRE the rotating
 *     `x-client-transaction-id` header — computed the same way x.com's own JS
 *     does it (x-client-transaction-id package). Without it they answer a
 *     silent 404 even with a perfectly valid session.
 *  3. If every candidate dies, the client re-derives FRESH queryIds straight
 *     from x.com's live main.js bundle (self-healing, zero maintenance).
 *
 * References: RSSHub lib/routes/twitter/api/web-api (production-maintained),
 * twitter-api-client, twikit.
 */

import { ClientTransaction, fetchXDocument } from "x-client-transaction-id";

const API_BASE = "https://x.com/i/api/graphql";

/** Public static bearer token embedded in x.com's frontend. */
export const WEB_BEARER =
  "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Candidate queryIds per operation. First = verified working against the live
 * gateway (2026-10); the rest are bundle-extracted / historical fallbacks.
 */
const QUERY_ID_CANDIDATES: Record<string, string[]> = {
  UserTweets: ["qJy3MbaNndtzxf9IqUzxMg", "0hWvDhmW8YQ-S_ib3azIrw", "E3opETHurmVJflFsUBVuUQ"],
  UserTweetsAndReplies: ["Z1m9j8S1leAzQp6yZXuaSg", "bt4TKuFz4T7Ckk-VvQVSow", "0hWvDhmW8YQ-S_ib3azIrw"],
  UserByScreenName: ["Yka-W8dz7RaEuQNkroPkYw", "KybxDj9RrADIITXlGG8kpw", "G3KGOYz9F0nG4DOYLR4AtQ"],
  UserByRestId: ["IdmRdjYxIGI39Hdwkwo5cQ", "Qw77dDjp9xCpUY-AXwt-yQ"],
  // Verified live against the gateway (2026-10) — the Following tab's own op
  Following: ["uwmIAx89XrXNuGY-Y7WFLg"],
};

const OPS_WITH_FRESH_IDS = Object.keys(QUERY_ID_CANDIDATES);

// ---------------------------------------------------------------------------
// x-client-transaction-id (required by protected timeline operations)
// ---------------------------------------------------------------------------

const TX_TTL_MS = 45 * 60 * 1000; // keys rotate with x.com deploys — refresh lazily
const globalForTx = globalThis as unknown as { __trTx?: { inst: ClientTransaction; at: number } };

async function getTxInstance(force = false): Promise<ClientTransaction> {
  const cached = globalForTx.__trTx;
  if (!force && cached && Date.now() - cached.at < TX_TTL_MS) return cached.inst;
  const doc = await fetchXDocument();
  const inst = await ClientTransaction.create(doc);
  globalForTx.__trTx = { inst, at: Date.now() };
  return inst;
}

/** Ops that silently 404 without the rotating transaction header. */
const TXID_OPS = new Set(["UserTweetsAndReplies", "SearchTimeline", "Following"]);

async function clientTxIdHeader(operation: string, qid: string): Promise<string | undefined> {
  if (!TXID_OPS.has(operation)) return undefined;
  try {
    const tx = await getTxInstance(false);
    return await tx.generateTransactionId("GET", `/i/api/graphql/${qid}/${operation}`);
  } catch {
    return undefined; // graceful degradation — RSSHub does the same
  }
}

// ---------------------------------------------------------------------------
// Self-healing queryId discovery (scrape x.com's own live bundle)
// ---------------------------------------------------------------------------

const DISCOVER_TTL_MS = 30 * 60 * 1000;
interface DiscoverState {
  ids: Map<string, string>;
  at: number;
  inflight?: Promise<void>;
}
const globalForDiscover = globalThis as unknown as { __trDiscover?: DiscoverState };

function discoverState(): DiscoverState {
  const existing = globalForDiscover.__trDiscover;
  if (existing) return existing;
  const fresh: DiscoverState = { ids: new Map(), at: 0 };
  globalForDiscover.__trDiscover = fresh;
  return fresh;
}

function discoveredIds(): Map<string, string> {
  return discoverState().ids;
}

async function discoverQueryIds(): Promise<void> {
  const st = discoverState();
  if (st.ids.size > 0 && Date.now() - st.at < DISCOVER_TTL_MS) return;
  if (st.inflight) return st.inflight;

  st.inflight = (async () => {
    const html = await fetch("https://x.com/home", {
      headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.text() : ""))
      .catch(() => "");
    if (!html) return;

    const bundleUrls = [...html.matchAll(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/[\w.-]+\.js/g)].map((m) => m[0]);
    const mains = bundleUrls.filter((u) => /\/main\.[\w-]+\.js$/.test(u));
    const targets = (mains.length > 0 ? mains : bundleUrls).slice(0, 2);

    for (const url of targets) {
      const js = await fetch(url, { headers: { "User-Agent": BROWSER_UA }, signal: AbortSignal.timeout(25_000), cache: "no-store" })
        .then((r) => (r.ok ? r.text() : ""))
        .catch(() => "");
      if (!js) continue;
      for (const op of OPS_WITH_FRESH_IDS) {
        if (st.ids.has(op)) continue;
        const pats = [
          new RegExp(`queryId:"([\\w-]+)",operationName:"${op}"`),
          new RegExp(`"queryId":"([\\w-]+)","operationName":"${op}"`),
        ];
        for (const p of pats) {
          const m = js.match(p);
          if (m) {
            st.ids.set(op, m[1]);
            break;
          }
        }
      }
    }
    st.at = Date.now();
  })();

  try {
    await st.inflight;
  } finally {
    st.inflight = undefined;
  }
}

/** QueryId currently known to work, cached per process (op → id). */
const globalForQid = globalThis as unknown as { __trQueryIds?: Map<string, string> };
const qidCache: Map<string, string> = (globalForQid.__trQueryIds ??= new Map());

// ---------------------------------------------------------------------------
// Feature switch payloads (mirror x.com's frontend; missing/extra keys are
// tolerated by the server, but this set is what RSSHub ships in production)
// ---------------------------------------------------------------------------

const FEATURES_USER = {
  hidden_profile_subscriptions_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_feature_can_gift_premium: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
};

const FEATURES_FEED = {
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface XSession {
  authToken: string;
  ct0: string | null;
}

/** Build the exact header set a logged-in x.com browser tab sends. */
function sessionHeaders(session: XSession): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: WEB_BEARER,
    "User-Agent": BROWSER_UA,
    Accept: "*/*",
    "Content-Type": "application/json",
    "x-twitter-active-user": "yes",
    "x-twitter-client-language": "en",
    Referer: "https://x.com/home",
    Origin: "https://x.com",
    Cookie: `auth_token=${session.authToken}`,
  };
  if (session.ct0) {
    headers.Cookie += `; ct0=${session.ct0}`;
    headers["x-csrf-token"] = session.ct0;
  }
  return headers;
}

export function isValidAuthToken(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value.trim());
}

// ---------------------------------------------------------------------------
// ct0 (CSRF) self-bootstrapping — the user only ever needs to paste auth_token.
// Visiting x.com with a valid auth_token makes X issue a fresh ct0 cookie;
// the GraphQL layer requires that ct0 (echoed as x-csrf-token) for protected
// GETs. X verifies the VALUE server-side (code 353 otherwise), so we derive
// it from x.com itself and refresh it whenever X rejects the current one.
// ---------------------------------------------------------------------------

const CT0_TTL_MS = 6 * 60 * 60 * 1000;
const globalForCt0 = globalThis as unknown as { __trCt0?: { token: string; at: number } };

export async function bootstrapCt0(authToken: string): Promise<string | null> {
  try {
    const res = await fetch("https://x.com/home", {
      headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml", Cookie: `auth_token=${authToken}` },
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
      redirect: "manual",
    });
    const cookies = res.headers.getSetCookie?.() ?? [];
    const ct0 = cookies.find((c) => c.startsWith("ct0="))?.split(";")[0].slice(4);
    return ct0 || null;
  } catch {
    return null;
  }
}

async function ensureCt0(session: XSession): Promise<string | null> {
  if (session.ct0) return session.ct0;
  const cached = globalForCt0.__trCt0;
  if (cached && Date.now() - cached.at < CT0_TTL_MS) return cached.token;
  const token = await bootstrapCt0(session.authToken);
  if (token) globalForCt0.__trCt0 = { token, at: Date.now() };
  return token;
}

export class GqlError extends Error {
  kind: "session_invalid" | "forbidden" | "rate_limited" | "endpoint_gone" | "network" | "parse";
  detail?: string;
  constructor(kind: GqlError["kind"], message: string, detail?: string) {
    super(message);
    this.kind = kind;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Core request with queryId fallback
// ---------------------------------------------------------------------------

async function gqlRequest<T>(operation: string, variables: object, features: object, session: XSession): Promise<T> {
  const params = {
    variables: JSON.stringify(variables),
    features: JSON.stringify(features),
  };
  const qs = new URLSearchParams(params).toString();
  const wantsTxid = TXID_OPS.has(operation);
  let activeCt0 = await ensureCt0(session);

  const buildCandidates = (): string[] => {
    const out: string[] = [];
    const cached = qidCache.get(operation);
    if (cached) out.push(cached);
    for (const id of QUERY_ID_CANDIDATES[operation] ?? []) {
      if (!out.includes(id)) out.push(id);
    }
    for (const id of discoveredIds().get(operation) ?? []) {
      if (!out.includes(id)) out.push(id);
    }
    return out;
  };

  let lastErr: GqlError | null = null;
  let csrfRetried = false;
  // Round 0: normal. Round 1: rebuild txid context (keys may have rotated).
  // Round 2: scrape x.com's live bundle for fresh queryIds, then retry.
  for (let round = 0; round < 3; round++) {
    if (round === 1 && wantsTxid) await getTxInstance(true).catch(() => null);
    if (round === 2) await discoverQueryIds().catch(() => null);

    for (const qid of buildCandidates()) {
      const headers = sessionHeaders({ authToken: session.authToken, ct0: activeCt0 });
      if (wantsTxid) {
        const txid = await clientTxIdHeader(operation, qid);
        if (txid) headers["x-client-transaction-id"] = txid;
      }

      let res: Response;
      try {
        res = await fetch(`${API_BASE}/${qid}/${operation}?${qs}`, {
          headers,
          signal: AbortSignal.timeout(15_000),
          cache: "no-store",
        });
      } catch (err) {
        throw new GqlError("network", `X request failed: ${err instanceof Error ? err.message : "network error"}`);
      }

      if (res.status === 404) {
        lastErr = new GqlError("endpoint_gone", `queryId for ${operation} no longer accepted`);
        continue; // dead queryId — try the next candidate
      }
      if (res.status === 429) {
        const reset = res.headers.get("x-rate-limit-reset");
        throw new GqlError("rate_limited", "X rate limit hit for this session", reset ? `resets ${reset}` : undefined);
      }
      if (res.status === 401) {
        const body = (await res.json().catch(() => null)) as { errors?: { code?: number; message?: string }[] } | null;
        const code = body?.errors?.[0]?.code;
        const msg = body?.errors?.[0]?.message ?? "Could not authenticate";
        throw new GqlError("session_invalid", `Session rejected (code ${code ?? "?"}): ${msg}`);
      }
      if (res.status === 403) {
        const body = (await res.json().catch(() => null)) as { errors?: { code?: number; message?: string }[] } | null;
        const code = body?.errors?.[0]?.code;
        const msg = body?.errors?.[0]?.message ?? "Forbidden";
        // 353 = csrf cookie/header rejected. X rotates ct0 server-side;
        // re-bootstrap it from x.com and retry the same request once.
        if (code === 353 && !csrfRetried) {
          csrfRetried = true;
          globalForCt0.__trCt0 = undefined;
          activeCt0 = await bootstrapCt0(session.authToken);
          if (activeCt0) {
            globalForCt0.__trCt0 = { token: activeCt0, at: Date.now() };
            round = -1; // restart rounds with the fresh csrf
            continue;
          }
        }
        // any other 403 usually means the session is expired/flagged
        throw new GqlError("forbidden", `X refused the request: ${msg}`);
      }
      if (!res.ok) {
        throw new GqlError("parse", `Unexpected X response HTTP ${res.status}`);
      }

      const data = (await res.json().catch(() => null)) as T | null;
      if (data === null) throw new GqlError("parse", "Malformed JSON from X");
      qidCache.set(operation, qid);
      return data;
    }
  }
  throw lastErr ?? new GqlError("endpoint_gone", `All queryIds rejected for ${operation}`);
}

// ---------------------------------------------------------------------------
// Typed results
// ---------------------------------------------------------------------------

export interface SessionProfile {
  id: string;
  screenName: string;
  name?: string;
  description?: string;
  followers?: number;
  following?: number;
  tweetCount?: number;
  verified?: boolean;
  protected?: boolean;
}

export interface SessionTweet {
  id: string;
  type: "POST" | "REPOST" | "REPLY" | "QUOTE";
  text: string;
  url: string;
  createdAt: string; // ISO
  /** Original author handle for reposts / quoted-handle info */
  targetUser?: string;
  metrics: { likes: number; retweets: number; replies: number; views: number };
}

// ---------------------------------------------------------------------------
// Raw GraphQL shapes (loose — we only touch what we need)
// ---------------------------------------------------------------------------

interface GqlUserCore {
  rest_id?: string;
  /** New-shape user id: base64 of "user:{rest_id}". */
  id?: string;
  /** OLD user shape (still served by UserByScreenName). */
  legacy?: {
    screen_name?: string;
    name?: string;
    description?: string;
    followers_count?: number;
    friends_count?: number;
    statuses_count?: number;
    verified?: boolean;
  };
  /** NEW (2026) user shape — screen_name/name moved under `core`. */
  core?: {
    screen_name?: string;
    name?: string;
    created_at?: string;
  };
  profile_bio?: { description?: string };
  relationship_counts?: { followers?: number; following?: number };
  statuses_count?: number;
  is_blue_verified?: boolean;
  protected?: boolean;
  privacy?: { protected?: boolean };
}

interface GqlTweetResult {
  __typename?: string;
  rest_id?: string;
  legacy?: {
    full_text?: string;
    created_at?: string;
    favorite_count?: number;
    retweet_count?: number;
    reply_count?: number;
    in_reply_to_status_id_str?: string | null;
    in_reply_to_screen_name?: string | null;
    is_quote_status?: boolean;
    retweeted_status_result?: { result?: GqlTweetResult | null } | null;
  };
  quoted_status_result?: { result?: GqlTweetResult | null } | null;
  core?: { user_results?: { result?: GqlUserCore | null } | null };
  views?: { count?: string };
  tweet?: GqlTweetResult; // TweetWithVisibilityResults wrapper
}

function unwrap(result: GqlTweetResult | null | undefined): GqlTweetResult | null {
  if (!result) return null;
  if (result.__typename === "TweetWithVisibilityResults" && result.tweet) return result.tweet;
  if (result.__typename === "Tweet") return result;
  return null; // TweetTombstone / TweetUnavailable / unknown
}

/** Decode the new-shape base64 user id ("VXNlcjoyMDk…" → "2099158476165361664"). */
function decodeUserId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    const restId = decoded.startsWith("user:") ? decoded.slice(5) : decoded;
    return /^\d+$/.test(restId) ? restId : undefined;
  } catch {
    return undefined;
  }
}

function authorHandle(t: GqlTweetResult): string | undefined {
  const user = t.core?.user_results?.result;
  return user?.legacy?.screen_name ?? user?.core?.screen_name ?? undefined;
}

function profileFromUserCore(user: GqlUserCore | null | undefined): SessionProfile | null {
  const legacy = user?.legacy;
  const screenName = legacy?.screen_name ?? user?.core?.screen_name;
  const id = user?.rest_id ?? decodeUserId(user?.id);
  if (!id && !screenName) return null;
  return {
    id: id ?? "",
    screenName: screenName ?? "",
    name: legacy?.name ?? user?.core?.name,
    description: legacy?.description ?? user?.profile_bio?.description,
    followers: legacy?.followers_count ?? user?.relationship_counts?.followers,
    following: legacy?.friends_count ?? user?.relationship_counts?.following,
    tweetCount: legacy?.statuses_count ?? user?.statuses_count,
    verified: user?.is_blue_verified ?? legacy?.verified,
    protected: user?.protected ?? user?.privacy?.protected,
  };
}

/** Parse a single GraphQL tweet result into our normalized shape. */
export function parseTweetResult(raw: GqlTweetResult, fallbackHandle: string): SessionTweet | null {
  const tweet = unwrap(raw);
  if (!tweet || !tweet.legacy) return null;

  const ownId = tweet.rest_id ?? "";
  if (!ownId) return null;
  const ownHandle = authorHandle(tweet) ?? fallbackHandle;

  const metrics = {
    likes: tweet.legacy.favorite_count ?? 0,
    retweets: tweet.legacy.retweet_count ?? 0,
    replies: tweet.legacy.reply_count ?? 0,
    views: Number(tweet.views?.count ?? 0) || 0,
  };
  const createdAt = tweet.legacy.created_at
    ? new Date(tweet.legacy.created_at).toISOString()
    : new Date().toISOString();

  // REPOST — surface the ORIGINAL post (that's what the user wants to read)
  const orig = tweet.legacy.retweeted_status_result?.result;
  const origTweet = unwrap(orig);
  if (origTweet?.legacy) {
    const origId = origTweet.rest_id ?? "";
    const origHandle = authorHandle(origTweet);
    const url = origHandle
      ? `https://x.com/${origHandle}/status/${origId}`
      : `https://x.com/i/status/${origId}`;
    const text = origTweet.legacy.full_text ?? tweet.legacy.full_text ?? "";
    return {
      id: ownId,
      type: "REPOST",
      text: text.replace(/^RT @\w+: /, "").trim(),
      url,
      createdAt,
      targetUser: origHandle,
      metrics: {
        likes: origTweet.legacy.favorite_count ?? metrics.likes,
        retweets: origTweet.legacy.retweet_count ?? metrics.retweets,
        replies: origTweet.legacy.reply_count ?? metrics.replies,
        views: Number(origTweet.views?.count ?? 0) || 0,
      },
    };
  }

  // QUOTE — the quote is the watched account's own post
  const quoted = tweet.quoted_status_result?.result;
  const quotedTweet = unwrap(quoted);
  if (tweet.legacy.is_quote_status) {
    return {
      id: ownId,
      type: "QUOTE",
      text: (tweet.legacy.full_text ?? "").trim(),
      url: `https://x.com/${ownHandle}/status/${ownId}`,
      createdAt,
      targetUser: quotedTweet ? authorHandle(quotedTweet) : undefined,
      metrics,
    };
  }

  // REPLY — own tweet that responds to someone
  if (tweet.legacy.in_reply_to_status_id_str) {
    return {
      id: ownId,
      type: "REPLY",
      text: (tweet.legacy.full_text ?? "").trim(),
      url: `https://x.com/${ownHandle}/status/${ownId}`,
      createdAt,
      targetUser: tweet.legacy.in_reply_to_screen_name ?? undefined,
      metrics,
    };
  }

  return {
    id: ownId,
    type: "POST",
    text: (tweet.legacy.full_text ?? "").trim(),
    url: `https://x.com/${ownHandle}/status/${ownId}`,
    createdAt,
    metrics,
  };
}

/** Recursively collect tweet results from any timeline shape (entries, modules, pinned). */
export function collectTweetResults(node: unknown, out: GqlTweetResult[], depth = 0): void {
  if (!node || typeof node !== "object" || depth > 8) return;
  const obj = node as Record<string, unknown>;

  const tweetResults = (obj as { tweet_results?: { result?: GqlTweetResult } }).tweet_results?.result;
  if (tweetResults) out.push(tweetResults);

  for (const key of ["content", "item", "itemContent", "entry", "moduleItem"]) {
    if (obj[key]) collectTweetResults(obj[key], out, depth + 1);
  }
  for (const key of ["entries", "items", "moduleItems", "timelineItems"]) {
    const arr = obj[key];
    if (Array.isArray(arr)) for (const child of arr) collectTweetResults(child, out, depth + 1);
  }
}

/**
 * Reply-thread modules ("profile-conversation-*") embed the watched account's
 * reply TOGETHER with the surrounding conversation — context tweets from OTHER
 * people, and sometimes the watched account's own thread root. Author cores
 * are stripped inside modules, so attribution uses reply direction:
 *   - context tweets are ADDRESSED TO the watched handle (in_reply_to = them)
 *   - the account's own tweets either don't reply (thread roots), reply to
 *     someone else (the person being answered), or sit LAST in the module
 *     (the anchor the module exists for — also covers self-threads)
 */
function isConversationModule(entry: unknown): boolean {
  const entryId = (entry as { entryId?: unknown })?.entryId;
  return typeof entryId === "string" && entryId.startsWith("profile-conversation-");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a handle to the real user record via UserByScreenName.
 * Used for session verification and id resolution when fxtwitter is unavailable.
 */
export async function fetchUserByScreenName(handle: string, session: XSession): Promise<SessionProfile> {
  const clean = handle.trim().replace(/^@/, "");
  const data = await gqlRequest<{
    data?: { user?: { result?: GqlUserCore | null } | null };
    errors?: { message?: string; code?: number }[];
  }>("UserByScreenName", { screen_name: clean }, FEATURES_USER, session);

  const profile = profileFromUserCore(data.data?.user?.result);
  if (!profile) {
    const msg = data.errors?.[0]?.message ?? "user not found";
    throw new GqlError("parse", `@${clean}: ${msg}`);
  }
  return profile;
}

export interface TimelineResult {
  user: SessionProfile | null; // fresh profile snapshot from the same response
  tweets: SessionTweet[];
  /** Cursor for the NEXT OLDER page (cursor-bottom) — enables catch-up reads.
   * Null when the response carried no cursor (end of timeline / odd shape). */
  nextCursor?: string | null;
}

/**
 * Fetch the watched user's timeline (posts, replies, quotes, reposts) using
 * the UserTweetsAndReplies web GraphQL operation. Also returns the fresh
 * profile snapshot embedded in the response so follower/bio tracking needs
 * zero extra requests.
 */
export async function fetchTimelineGraphQL(
  userId: string,
  handle: string,
  session: XSession,
  cursor?: string
): Promise<TimelineResult> {
  const variables: Record<string, unknown> = {
    userId,
    count: 20,
    includePromotedContent: false,
    withCommunity: true,
    withVoice: true,
    withV2Timeline: true,
  };
  // Pagination: when a cursor is supplied (catch-up read after a burst or a
  // downtime gap), the operation returns the NEXT OLDER page instead of the head.
  if (cursor) variables.cursor = cursor;

  const data = await gqlRequest<{
    data?: {
      user?: {
        result?: GqlUserCore & {
          timeline_v2?: { timeline?: { instructions?: unknown[] } };
          timeline?: { timeline?: { instructions?: unknown[] } };
        } | null;
      } | null;
    };
    errors?: { message?: string }[];
  }>("UserTweetsAndReplies", variables, FEATURES_FEED, session);

  const userResult = data.data?.user?.result ?? null;
  const profile = profileFromUserCore(userResult);

  const instructions =
    userResult?.timeline_v2?.timeline?.instructions ?? userResult?.timeline?.timeline?.instructions ?? [];

  // Bottom cursor: the timeline appends "cursor-bottom-*" entries whose content
  // value is the token for the next-older page. Grab the LAST one seen.
  let nextCursor: string | null = null;
  for (const instruction of instructions) {
    const entries = (instruction as { entries?: unknown[] })?.entries;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const e = entry as { entryId?: string; content?: { entryType?: string; value?: string } };
      if (e.entryId?.startsWith("cursor-bottom-") && e.content?.value) {
        nextCursor = e.content.value;
      }
    }
  }

  const raws: GqlTweetResult[] = [];
  const push = (raw: GqlTweetResult) => {
    if (raw.rest_id && !raws.some((r) => r.rest_id === raw.rest_id)) raws.push(raw);
  };

  const ownHandleLower = handle.toLowerCase();
  for (const instruction of instructions) {
    const entries = (instruction as { entries?: unknown[] })?.entries;
    if (!Array.isArray(entries)) {
      const scoped: GqlTweetResult[] = [];
      collectTweetResults(instruction, scoped);
      for (const r of scoped) push(r);
      continue;
    }
    for (const entry of entries) {
      if (!isConversationModule(entry)) {
        // Standalone entries on a profile timeline are always the watched
        // account's own tweets (RT wrappers included) — context never
        // appears outside conversation modules.
        const scoped: GqlTweetResult[] = [];
        collectTweetResults(entry, scoped);
        for (const r of scoped) push(r);
        continue;
      }

      // Conversation module — attribute by reply direction (see helper docs).
      const items = (((entry as { content?: { items?: unknown[] } }).content?.items ?? []) as unknown[]);
      items.forEach((item, idx) => {
        const scopedItem: GqlTweetResult[] = [];
        collectTweetResults(item, scopedItem);
        const isLast = idx === items.length - 1;
        for (const r of scopedItem) {
          const replyTo = r.legacy?.in_reply_to_screen_name?.toLowerCase() ?? null;
          if (replyTo === null || replyTo !== ownHandleLower || isLast) push(r);
        }
      });
    }
  }

  // Attribution is exact via author handles (X's 2026 user shape exposes
  // screen_name under result.core — authorHandle reads both shapes). The
  // reply-direction rule above only guards hypothetical authorless payloads.
  const ownRaws = raws.filter((raw) => {
    const author = authorHandle(raw);
    return !author || author.toLowerCase() === ownHandleLower;
  });

  const seen = new Set<string>();
  const tweets: SessionTweet[] = [];
  for (const raw of ownRaws) {
    const parsed = parseTweetResult(raw, handle);
    if (parsed && !seen.has(parsed.id)) {
      seen.add(parsed.id);
      tweets.push(parsed);
    }
  }
  tweets.sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1));
  return { user: profile, tweets, nextCursor };
}

export interface FollowEntry {
  handle: string; // lowercase screen_name
  userId?: string;
}

/**
 * Fetch who a user follows (the Following tab) via the free web GraphQL
 * session. X orders the list most-recent-follow-first, so the head of this
 * list is exactly where NEW follows appear. One page (100 entries) is enough
 * for new-follow detection: any follow newer than the previous sweep sits at
 * the top. Private/protected following lists answer with an empty user result
 * → we return [] and the caller keeps the previous baseline.
 */
export async function fetchFollowingList(
  userId: string,
  session: XSession,
  count = 100
): Promise<FollowEntry[]> {
  const variables = { userId, count, includePromotedContent: false };
  const data = await gqlRequest<{
    data?: {
      user?: {
        result?: {
          timeline?: { timeline?: { instructions?: unknown[] } };
          timeline_v2?: { timeline?: { instructions?: unknown[] } };
        } | null;
      } | null;
    };
  }>("Following", variables, FEATURES_FEED, session);

  const instructions =
    data.data?.user?.result?.timeline?.timeline?.instructions ??
    data.data?.user?.result?.timeline_v2?.timeline?.instructions ??
    [];

  const out: FollowEntry[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown, depth: number): void => {
    if (!node || typeof node !== "object" || depth > 12) return;
    const obj = node as Record<string, unknown>;
    // User objects: legacy shape (screen_name under legacy) or 2026 shape (core)
    const legacy = obj.legacy as { screen_name?: string } | undefined;
    const core = obj.core as { screen_name?: string } | undefined;
    const handle = (legacy?.screen_name ?? core?.screen_name ?? "").toLowerCase();
    if (handle && !seen.has(handle)) {
      seen.add(handle);
      const id =
        typeof obj.rest_id === "string" ? obj.rest_id : decodeUserId(obj.id as string | undefined);
      out.push({ handle, userId: id });
    }
    for (const key of ["entries", "items", "moduleItems", "content", "itemContent", "entry", "user_results", "user", "result", "users"]) {
      const child = obj[key];
      if (Array.isArray(child)) for (const c of child) walk(c, depth + 1);
      else if (child && typeof child === "object") walk(child, depth + 1);
    }
  };
  for (const instruction of instructions) walk(instruction, 0);

  return out;
}

/**
 * Verify a session end-to-end: resolves a known public handle and, when
 * possible, identifies the burner account behind auth_token via the legacy
 * verify_credentials endpoint. Throws GqlError on invalid sessions.
 */
export async function verifySession(session: XSession): Promise<{ testProfile: SessionProfile; sessionUser?: { name: string; screenName: string } }> {
  // 1. Prove the session can read a timeline-bearing endpoint
  const testProfile = await fetchUserByScreenName("X", session);

  // 2. Best-effort: identify the logged-in burner account (non-fatal)
  let sessionUser: { name: string; screenName: string } | undefined;
  try {
    const res = await fetch("https://x.com/i/api/1.1/account/verify_credentials.json?skip_status=true&include_entities=false", {
      headers: sessionHeaders(session),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (res.ok) {
      const me = (await res.json()) as { name?: string; screen_name?: string };
      if (me.screen_name) sessionUser = { name: me.name ?? "", screenName: me.screen_name };
    }
  } catch {
    /* identity lookup optional */
  }
  return { testProfile, sessionUser };
}
