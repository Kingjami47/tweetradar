import { NextRequest, NextResponse } from "next/server";

/**
 * CSRF guard for mutating API requests.
 *
 * Browsers ALWAYS attach an Origin header to POST/PUT/PATCH/DELETE requests —
 * including cross-origin ones (a malicious page can submit `fetch` with a
 * text/plain JSON body without any preflight, so content-type checks prove
 * nothing). Non-browser clients (curl, scripts, the server's own poller) never
 * send Origin.
 *
 * Rule: if Origin is present, its host must match the request's Host (or the
 * X-Forwarded-Host behind a preview proxy). Mismatch → 403. This blocks
 * drive-by web pages from silently deleting the watchlist, adding accounts or
 * swapping the Telegram bot token (which would exfiltrate every future alert
 * to an attacker-controlled chat) while the operator is browsing the web.
 *
 * X-Forwarded-Host is a forbidden header name in browsers — client JS can
 * neither set it on the forged request nor spoof the match.
 */
export function middleware(req: NextRequest) {
  const method = req.method.toUpperCase();
  if (method !== "POST" && method !== "PUT" && method !== "PATCH" && method !== "DELETE") {
    return NextResponse.next();
  }

  const origin = req.headers.get("origin");
  if (!origin) return NextResponse.next(); // curl / server-side / no-browser client

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return NextResponse.json({ error: "Malformed Origin header" }, { status: 403 });
  }

  const forwardedHost = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const allowedHosts = [req.headers.get("host"), forwardedHost].filter(
    (h): h is string => Boolean(h)
  );

  if (allowedHosts.includes(originHost)) return NextResponse.next();

  console.log(
    `[TweetRadar] blocked cross-origin ${method} ${req.nextUrl.pathname} from ${origin}`
  );
  return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
}

export const config = {
  matcher: "/api/:path*",
};
