# syntax=docker/dockerfile:1.7
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG NEXT_PUBLIC_PROBE_AGENT_VERSION
FROM node:22-alpine AS base
WORKDIR /app

FROM base AS build
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_PROBE_AGENT_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_PROBE_AGENT_VERSION=$NEXT_PUBLIC_PROBE_AGENT_VERSION
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN node -e 'const version = process.env.NEXT_PUBLIC_PROBE_AGENT_VERSION || ""; if (version && !/^v\d+\.\d+\.\d+$/.test(version)) throw new Error("NEXT_PUBLIC_PROBE_AGENT_VERSION must be empty or an explicit vN.N.N tag")'
RUN pnpm build

FROM base AS api
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 4000
CMD ["node", "apps/api/dist/main.js"]

FROM base AS worker
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
USER node
CMD ["node", "apps/worker/dist/main.js"]

FROM base AS web
ENV NODE_ENV=production
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_PROBE_AGENT_VERSION
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_PROBE_AGENT_VERSION=$NEXT_PUBLIC_PROBE_AGENT_VERSION
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
