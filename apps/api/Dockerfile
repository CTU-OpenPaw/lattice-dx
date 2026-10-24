# SPDX-License-Identifier: Apache-2.0
FROM node:24.15.0-alpine
WORKDIR /app
RUN npm install --global pnpm@10.23.0
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY apps/api ./apps/api
COPY solutions/workflows ./solutions/workflows
COPY scripts/lib/ngsi-ld-client.mjs ./scripts/lib/ngsi-ld-client.mjs
COPY infra/config/ngsi-ld/context.jsonld ./infra/config/ngsi-ld/context.jsonld
RUN pnpm install --frozen-lockfile --filter @dx/api...
RUN mkdir -p /var/lib/latticedx/objects && chown node:node /var/lib/latticedx/objects && chmod 700 /var/lib/latticedx/objects
USER node
EXPOSE 4000
CMD ["pnpm", "--filter", "@dx/api", "start"]