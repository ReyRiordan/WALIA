FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm i -g pnpm@10.34.5
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:24-bookworm-slim
WORKDIR /app
RUN npm i -g pnpm@10.34.5
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /app/dist ./dist
COPY config.json ./
USER node
CMD ["node", "--no-warnings=ExperimentalWarning", "dist/index.js"]
