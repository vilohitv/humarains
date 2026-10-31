# Humarains — production image. Only needed if you deploy with Docker instead of
# Render's native Node runtime (see render.yaml).
FROM node:20-alpine

# pg_dump / pg_restore for scripts/backup.js, aws-cli to upload backups off-site (BACKUP_S3_URI)
RUN apk add --no-cache postgresql-client aws-cli

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Run as an unprivileged user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup && chown -R appuser:appgroup /app
USER appuser

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/system/status || exit 1

# The server creates the database schema (db/schema.sql) on first startup.
# Run the same image as the background worker with:  node src/worker.js  (and PROCESS_ROLE=web on the web side).
CMD ["node", "src/server.js"]
