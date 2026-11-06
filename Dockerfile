FROM node:24-alpine AS base
WORKDIR /app

FROM base AS worker-dependencies
COPY services/worker-runtime/package.json services/worker-runtime/package-lock.json ./
RUN npm ci

FROM worker-dependencies AS worker-build
COPY prisma ./prisma
COPY prisma7.config.ts ./prisma7.config.ts
COPY tsconfig.json ./tsconfig.json
COPY src ./src
COPY services/agent ./services/agent
COPY scripts ./scripts
ARG DATABASE_URL="postgresql://build:build@localhost:5432/build"
ENV DATABASE_URL=$DATABASE_URL
RUN npx prisma generate --config prisma7.config.ts

FROM base AS worker-production-dependencies
COPY services/worker-runtime/package.json services/worker-runtime/package-lock.json ./
RUN npm ci --omit=dev --omit=peer

FROM base AS worker-runtime
ENV NODE_ENV=production
COPY --from=worker-production-dependencies /app/node_modules ./node_modules
COPY --from=worker-build /app/package.json ./package.json
COPY --from=worker-build /app/src ./src
COPY --from=worker-build /app/services/agent ./services/agent
COPY --from=worker-build /app/generated ./generated
COPY --from=worker-build /app/prisma ./prisma
COPY --from=worker-build /app/prisma7.config.ts ./prisma7.config.ts
COPY --from=worker-build /app/tsconfig.json ./tsconfig.json
COPY --from=worker-build /app/scripts ./scripts
