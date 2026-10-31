FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS build
WORKDIR /app
RUN npm install --global pnpm@12.4.2
COPY --chown=node:node . .
RUN pnpm install --frozen-lockfile && pnpm db:generate && pnpm build
RUN mkdir -p /app/var/private /app/var/exports && chown -R node:node /app/var && chmod 700 /app/var/private /app/var/exports

FROM build AS runtime
ENV NODE_ENV=production SERVER_HOST=0.0.0.0
USER node
CMD ["node", "apps/api/dist/main.js"]

FROM caddy:2-alpine@sha256:e70b164da81ef698b3ad19af799ea6086ce6d9e48ed4079eb9fe26f6fbf14ee5 AS web
COPY --from=build /app/apps/web/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY deploy/Caddyfile.routes /etc/caddy/Caddyfile.routes

RUN caddy adapt --config /etc/caddy/Caddyfile > /dev/null
