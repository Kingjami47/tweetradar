# 🛰 TweetRadar

A self-hosted **X/Twitter monitoring radar** with a built-in **Telegram bot** and a
silent **anti-spam Link Guard** for Telegram groups — built to run 24/7 on a single
free sandbox, with **zero paid API requirements**.

Point it at any X account and it watches that account around the clock: new posts,
replies, quotes, reposts, profile edits and new follows land in a live dashboard
feed and get pushed to your private Telegram chat as rich alerts. You control the
whole thing by chatting with the bot (`+ @handle`, `− @handle`, `/list` — no
dashboard needed).

---

## ✨ What it does

### 1. Account radar (the core)
- **Watchlist** — track any number of X handles; add/remove from the dashboard or
  straight from Telegram (`+ @naval`, bulk `+ @u1 @u2 …`, `− @handle`, `/list`).
- **Scan engine** runs on a background loop (interval configurable in the UI) and
  captures, per watched account:
  - 📝 new posts
  - 💬 replies (with the parent-context module)
  - 🔁 reposts & quotes
  - 👤 profile edits (bio / name / avatar changes)
  - 📈 follower milestones & **new notable follows**
- **Activity feed** — a searchable, filterable dashboard feed of every captured
  event with canonical post URLs (opens straight on x.com).

### 2. Three data-acquisition modes (auto-fallback, all free)
| Mode | How it works | Cost |
|---|---|---|
| **Session** | a burner account's `auth_token` cookie → real x.com web-client GraphQL (`UserTweetsAndReplies`) — full timeline + profile in one request | free |
| **FixTweet** | keyless reads via the public `api.fxtwitter.com` endpoint — the reliable zero-credential fallback | free |
| **X API v2** | classic Bearer-token mode if you have a developer account | free tier |

### 3. Telegram bot (two-way, no webhook needed)
- Plain **`getUpdates` long-polling** — no public URL, no webhook, no extra infra.
- **Anonymity lock**: the public command menu and bot description are wiped in
  every scope; strangers who discover the bot get total silence — nothing reveals
  what it does. Only your private chat can command it (and only a private chat can
  ever claim the alert target).
- **Rich alerts** — posts/replies/reposts/follows are formatted with the account,
  snippet and canonical link; notification scope (follows / posts / replies /
  reposts) is toggleable per chat.

### 4. 🛡 Link Guard (anti-spam enforcement)
Arm it by sending `/guard` inside any Telegram group or channel where the bot is
admin — from then on it enforces **silently, 24/7**:
- **Any link** (plain URL, hyperlink text, media caption) posted by a **direct
  member** → **message deleted + member banned**, instantly and invisibly.
- **Always exempt** (unspoofable — Telegram sets `sender_chat` only for
  privileged senders, so members can never fake it):
  - auto-forwarded posts from a **linked channel** (your channel broadcasts)
  - **anonymous admin** posts
  - posts sent **"as the channel"**
  - Telegram's own service account
- **The owner is always exempt**; other admins are exempt by default and
  `/guard strict` removes that exemption.
- Every enforcement is logged (`GuardLog`) and reported **only to the owner's
  private DM** — the bot never posts anything inside the guarded chat, and the
  owner's own `/guard` command is wiped from the group (stealth mode).
- `deleteMessage` runs **before** `banChatMember`, with bounded retries that
  honour Telegram's `retry_after` — so the link dies even if the ban hiccups.
- `/guard test` performs a **live self-test**: it posts a marker message through
  the real enforcement pipeline as a fake member and reports per-step results
  (detection → delete → ban) back to your DM, then cleans up after itself.

---

## 🧱 Tech stack

- **Next.js 16** (App Router) + **TypeScript**
- **Tailwind CSS 4** + **shadcn/ui** component library
- **Prisma ORM** + **SQLite** (`WatchedAccount`, `ActivityEvent`, `Settings`, `ScanLog`, `GuardLog`)
- **Bun** as the runtime / package manager
- Telegram Bot API via plain `fetch` — no SDKs, no webhooks, no paid services

## 🚀 Getting started

```bash
# 1. install
bun install

# 2. database (SQLite — file is created automatically)
#    .env → DATABASE_URL=file:./db/custom.db

# 3. push the schema
bunx prisma db push

# 4. run
bun run dev          # http://localhost:3000
```

**Setup (2 minutes):**
1. Create a bot with [@BotFather](https://t.me/BotFather) → copy the token.
2. Open the dashboard → Settings → paste the bot token.
3. Message your bot once from your private Telegram chat — the **first private
   chat to talk to it claims the alert target** (groups can never claim it).
4. Add accounts: `+ @handle` in Telegram or on the dashboard.
5. *(optional)* Add the bot as admin (**Delete messages** + **Ban users**) to a
   group and send `/guard` there to arm the Link Guard.

## 📁 Project layout

```
src/
├── app/                 # Next.js App Router (dashboard UI + API routes)
├── components/          # shadcn/ui component library
├── lib/
│   ├── monitor.ts       # scan engine — sessions, events, profile tracking
│   ├── scheduler.ts     # background scan loop (interval re-read each cycle)
│   ├── twitter.ts       # X API v2 client (live mode)
│   ├── x-graphql.ts     # x.com web-client GraphQL client (session mode)
│   ├── fxtwitter.ts     # keyless FixTweet fallback
│   ├── telegram.ts      # Telegram send/format helpers
│   ├── telegram-commands.ts  # bot poller, command parser, owner gate
│   ├── guard.ts         # Link Guard — detection, exemptions, delete+ban
│   └── settings.ts      # typed settings access
├── hooks/               # React hooks (toasts, mobile detection)
└── instrumentation.ts   # boots the scheduler + Telegram poller on server start
prisma/schema.prisma     # data model (SQLite)
```

## 🔐 Security notes

- The SQLite database (`db/`) holds your **bot token** and any **X session
  cookies** — it is `.gitignore`d and must never be committed or shared.
- `.env` only carries the local `DATABASE_URL`; no secrets live in the repo.
- The bot's anonymity lock means discovering its username reveals nothing.
