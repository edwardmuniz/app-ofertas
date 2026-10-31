# Imagem única da plataforma: api, worker, redirect e painel (o comando muda por serviço).
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
RUN npm i -g pnpm@9.15.4
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/cli/package.json apps/cli/
COPY apps/redirect/package.json apps/redirect/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/connectors/package.json packages/connectors/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/render/package.json packages/render/
RUN pnpm install --frozen-lockfile
COPY . .
# O painel encaminha /api/* para a API pela rede interna do compose.
ARG API_INTERNAL_URL=http://api:3001
ARG API_PUBLIC_URL=http://localhost:3001
ENV API_INTERNAL_URL=$API_INTERNAL_URL API_PUBLIC_URL=$API_PUBLIC_URL
RUN pnpm --filter @ofertas/web build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
RUN mkdir -p /data/media && chown -R node:node /data
USER node
EXPOSE 3000 3001 3002
CMD ["pnpm", "--filter", "@ofertas/api", "start"]
