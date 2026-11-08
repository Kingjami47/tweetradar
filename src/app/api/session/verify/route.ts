import { NextRequest, NextResponse } from "next/server";
import { getSettings, saveSettings } from "@/lib/settings";
import { isValidAuthToken, verifySession, GqlError } from "@/lib/x-graphql";

/**
 * Verify the burner-session cookies (optionally saving them first).
 * Body: { xAuthToken?, xCt0?, persist? }
 *  - xAuthToken/xCt0 provided → verify those values (and save when persist)
 *  - not provided → verify the stored ones
 * Returns { ok, sessionUser?, note } or { ok:false, error, errorKind }.
 */
export async function POST(req: NextRequest) {
  let body: { xAuthToken?: string; xCt0?: string; persist?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body = verify stored session */
  }

  const stored = await getSettings();
  const candidateAuthToken = (body.xAuthToken ?? "").trim() || stored.xAuthToken;
  const candidateCt0 = (body.xCt0 ?? "").trim() || stored.xCt0;

  if (!candidateAuthToken) {
    return NextResponse.json(
      {
        ok: false,
        errorKind: "missing",
        error: "No auth_token cookie provided. Copy it from a logged-in x.com tab (DevTools → Application → Cookies).",
      },
      { status: 400 }
    );
  }
  if (!isValidAuthToken(candidateAuthToken)) {
    return NextResponse.json(
      {
        ok: false,
        errorKind: "malformed",
        error: "auth_token should be a 40-character hexadecimal string. Re-copy the cookie value from your browser.",
      },
      { status: 400 }
    );
  }

  try {
    const { sessionUser } = await verifySession({ authToken: candidateAuthToken, ct0: candidateCt0 });
    if (body.persist) {
      await saveSettings({ xAuthToken: candidateAuthToken, xCt0: candidateCt0 });
    }
    return NextResponse.json({
      ok: true,
      sessionUser: sessionUser ?? null,
      note: sessionUser
        ? `Session verified — logged in as @${sessionUser.screenName}.`
        : "Session verified — X accepted the cookies for timeline reads.",
    });
  } catch (err) {
    if (err instanceof GqlError) {
      return NextResponse.json(
        {
          ok: false,
          errorKind: err.kind,
          error:
            err.kind === "session_invalid"
              ? "X rejected these cookies (invalid or expired). Log in on x.com, then re-copy auth_token and ct0."
              : err.message,
        },
        { status: 200 }
      );
    }
    return NextResponse.json(
      { ok: false, errorKind: "network", error: err instanceof Error ? err.message : "Unknown error" },
      { status: 200 }
    );
  }
}
