FROM node:24-alpine AS base
WORKDIR /app

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY . .
ARG DATABASE_URL="postgresql://build:build@localhost:5432/build"
ENV DATABASE_URL=$DATABASE_URL
RUN npx prisma generate --config prisma7.config.ts && npm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/src ./src
COPY --from=build /app/generated ./generated
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma7.config.ts ./prisma7.config.ts

EXPOSE 3000
CMD ["npm", "run", "start"]
