# @file LatticeDX — Open Digital Enterprise Platform
# @author CTU-OpenPaw
# @copyright (C) 2026 CTU-OpenPaw
# @license Apache-2.0
# @see https://github.com/CTU-OpenPaw/lattice-dx
# SPDX-License-Identifier: Apache-2.0
FROM library/node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS builder
WORKDIR /app
RUN npm install --global pnpm@10.23.0
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig*.json ./
COPY apps/file-scanner/package.json ./apps/file-scanner/package.json
RUN pnpm install --frozen-lockfile --filter . --filter @dx/file-scanner...
COPY apps/file-scanner/tsconfig*.json ./apps/file-scanner/
COPY apps/file-scanner/src ./apps/file-scanner/src
RUN pnpm --filter @dx/file-scanner build

FROM library/node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
WORKDIR /app
COPY --from=builder /app/apps/file-scanner/package.json ./
COPY --from=builder /app/apps/file-scanner/dist ./dist
RUN mkdir -p /var/lib/latticedx/objects && chown node:node /var/lib/latticedx/objects && chmod 700 /var/lib/latticedx/objects
USER node
EXPOSE 4010
HEALTHCHECK --interval=10s --timeout=5s --retries=12 CMD ["node", "-e", "fetch('http://127.0.0.1:4010/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
