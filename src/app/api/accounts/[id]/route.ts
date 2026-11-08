import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

const ID_RE = /^[a-z0-9]{20,30}$/i;

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!ID_RE.test(id)) return NextResponse.json({ error: "Invalid account id" }, { status: 400 });

  let body: {
    active?: boolean;
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

  const account = await db.watchedAccount.findUnique({ where: { id } });
  if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 });

  const data: Record<string, unknown> = {};
  if ("active" in body) data.active = Boolean(body.active);
  if ("trackPosts" in body) data.trackPosts = Boolean(body.trackPosts);
  if ("trackReplies" in body) data.trackReplies = Boolean(body.trackReplies);
  if ("trackReposts" in body) data.trackReposts = Boolean(body.trackReposts);
  if ("trackLikes" in body) data.trackLikes = Boolean(body.trackLikes);
  if ("trackFollows" in body) data.trackFollows = Boolean(body.trackFollows);
  if ("notes" in body) {
    // Coerce defensively: a non-string notes value (number/bool from a buggy
    // client) would throw on .slice and 500 the whole PATCH.
    data.notes = typeof body.notes === "string" ? body.notes.slice(0, 300) || null : null;
  }

  const updated = await db.watchedAccount.update({ where: { id }, data });
  return NextResponse.json(updated);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!ID_RE.test(id)) return NextResponse.json({ error: "Invalid account id" }, { status: 400 });

  const account = await db.watchedAccount.findUnique({ where: { id } });
  if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 });

  await db.watchedAccount.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
