# ---- build stage: full image has the toolchain to compile better-sqlite3 if no prebuilt exists ----
FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public

# ---- runtime stage: slim image, non-root, data on a mounted volume ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DB_FILE=/data/voting.db
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/public ./public
COPY package.json ./

# Persist the SQLite database outside the container layer.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||3000)).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
