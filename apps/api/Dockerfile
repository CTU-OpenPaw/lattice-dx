# SPDX-License-Identifier: Apache-2.0
FROM node:24.15.0-alpine
WORKDIR /app
RUN npm install --global pnpm@10.23.0
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY apps/api ./apps/api
RUN pnpm install --frozen-lockfile --filter @dx/api...
USER node
EXPOSE 4000
CMD ["pnpm", "--filter", "@dx/api", "start"]
