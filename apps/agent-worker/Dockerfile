# @file LatticeDX — Open Digital Enterprise Platform
# @author CTU-OpenPaw
# @copyright (C) 2026 CTU-OpenPaw
# @license Apache-2.0
# @see https://github.com/CTU-OpenPaw/lattice-dx
# SPDX-License-Identifier: Apache-2.0
FROM node:24.15.0-alpine
WORKDIR /app
RUN npm install --global pnpm@10.23.0
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY apps/agent-worker ./apps/agent-worker
RUN pnpm install --frozen-lockfile --filter @dx/agent-worker...
USER node
EXPOSE 4001
HEALTHCHECK --interval=10s --timeout=5s --retries=12 CMD ["node", "-e", "fetch('http://127.0.0.1:4001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["pnpm", "--filter", "@dx/agent-worker", "start"]
