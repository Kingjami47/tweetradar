import { NextRequest, NextResponse } from "next/server";
import { addWatchedAccounts, normalizeHandle, tokenizeHandleList, USERNAME_RE } from "@/lib/accounts";
import { runScan } from "@/lib/monitor";

const MAX_BATCH = 25;

/**
 * POST /api/accounts/bulk — add up to 25 handles in one shot.
 * Body: { usernames: string[] | string, tracks?: {...}, notes?: string }
 * `usernames` may also be a single delimited string (spaces, commas, newlines).
 * Returns per-handle results so the UI can show exactly what happened.
 */
export async function POST(req: NextRequest) {
  let body: {
    usernames?: string[] | string;
    trackPosts?: boolean;
    trackReplies?: boolean;
    trackReposts?: boolean;
    trackLikes?: boolean;
    trackFollows?: boolean;
    notes?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Tolerant tokenization: accepts ["a","b"], "a b c", and pasted lists like
  // "+@a\n+@b\n+@c" or "add @a, add @b" — glued signs/@ and command words
  // never leak through as phantom handles.
  const handles = (
    Array.isArray(body.usernames)
      ? body.usernames.flatMap((u) => (typeof u === "string" ? tokenizeHandleList(u) : []))
      : typeof body.usernames === "string"
        ? tokenizeHandleList(body.usernames)
        : []
  )
    .map(normalizeHandle)
    .filter((h) => h.length > 0);

  if (handles.length === 0) {
    return NextResponse.json({ error: "Provide at least one username" }, { status: 400 });
  }
  if (handles.length > MAX_BATCH) {
    return NextResponse.json(
      { error: `Too many handles — up to ${MAX_BATCH} per batch (got ${handles.length})` },
      { status: 400 }
    );
  }

  const preInvalid = handles.filter((h) => !USERNAME_RE.test(h));
  const candidates = handles.filter((h) => USERNAME_RE.test(h));

  const results = [
    ...(await addWatchedAccounts(candidates, {
      tracks: {
        trackPosts: body.trackPosts,
        trackReplies: body.trackReplies,
        trackReposts: body.trackReposts,
        trackLikes: body.trackLikes,
        trackFollows: body.trackFollows,
      },
      notes: body.notes,
    })),
    ...preInvalid.map((h) => ({
      input: h,
      ok: false,
      alreadyTracked: false, // an invalid handle can never have been tracked
      error: "Invalid X/Twitter handle — use 1–15 letters, numbers or underscores",
      errorKind: "invalid" as const,
    })),
  ];

  const added = results.filter((r) => r.ok && !r.alreadyTracked).length;
  const alreadyTracked = results.filter((r) => r.alreadyTracked).length;
  const failed = results.filter((r) => !r.ok).length;

  // One immediate sweep so every fresh account bootstraps right away
  if (added > 0) void runScan("manual").catch(() => undefined);

  return NextResponse.json(
    {
      added,
      alreadyTracked,
      failed,
      results,
    },
    { status: added > 0 ? 201 : 200 }
  );
}
