# TweetRadar — Railway deployment image
# The app needs a PERSISTENT SQLite database and a LONG-RUNNING process
# (24/7 scan scheduler + Telegram getUpdates poller + Link Guard), which is
# exactly what Railway containers+volumes provide (and serverless does not).

FROM oven/bun:1
WORKDIR /app

# 1. dependencies (cached until lockfile changes)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# 2. app source + production build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN bunx prisma generate && bun run build

# 3. runtime config — SQLite lives on the attached Railway volume (/data)
ENV NODE_ENV=production
ENV DATABASE_URL=file:/data/tweetradar.db
ENV PORT=3000
EXPOSE 3000

# First boot: seed the volume from the bundled snapshot (watchlist, settings,
# guard state) so the deployed instance continues exactly where this app left
# off. Later boots keep whatever is on the volume. A missing snapshot (e.g. a
# build from the public repo) simply starts with a fresh migrated database.
CMD ["sh", "-c", "mkdir -p /data && if [ ! -f /data/tweetradar.db ] && [ -f db/custom.db ]; then cp db/custom.db /data/tweetradar.db; fi && bunx prisma db push --skip-generate && bun .next/standalone/server.js"]
