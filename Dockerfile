FROM node:24-slim AS build
WORKDIR /app
RUN npm install -g pnpm@10.29.2
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json gateway.yaml ./
COPY drizzle ./drizzle
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
