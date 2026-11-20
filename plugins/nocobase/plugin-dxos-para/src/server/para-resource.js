/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { PARA_SPACES } = require('./schema');
const { resolveParaActor } = require('./para-scope');

const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);

function createParaActions(db) {
  return {
    summary: async (ctx, next) => {
      if (ctx.method !== 'GET') ctx.throw(405);
      const isRoot = ctx.state?.currentRole === 'root';
      let organizationId = null;
      if (isRoot) {
        const requested = ctx.action?.params?.organizationId;
        if (typeof requested === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(requested.trim())) {
          organizationId = requested.trim();
        }
      } else {
        const actor = await resolveParaActor(db, ctx.state?.currentUser);
        organizationId = actor.organizationId;
      }

      const repo = db.getRepository('latticeParaDocuments');
      const filter = { active: true, ...(organizationId ? { organizationId } : {}) };
      const rows = repo ? await repo.find({ filter, fields: ['id', 'paraSpace', 'active', 'organizationId'] }) : [];
      const spaces = Object.fromEntries(PARA_SPACES.map((space) => [space, 0]));
      for (const row of Array.isArray(rows) ? rows : []) {
        if (val(row, 'active') === false) continue;
        const space = val(row, 'paraSpace') || 'projects';
        if (Object.hasOwn(spaces, space)) spaces[space] += 1;
      }
      const total = Object.values(spaces).reduce((acc, n) => acc + n, 0);
      ctx.body = { organizationId, spaces, total };
      await next();
    },
  };
}

module.exports = { createParaActions };
