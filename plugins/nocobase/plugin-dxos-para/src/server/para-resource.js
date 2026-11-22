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
const { executeHybridSearch } = require('./para-hybrid-search');

const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);

function createParaActions(db) {
  return {
    summary: async (ctx, next) => {
      if (ctx.method !== 'GET') ctx.throw(405);
      const isRoot = ctx.state?.currentRole === 'root';
      let organizationId = null;
      let organizations = [];
      if (isRoot) {
        const requested = ctx.action?.params?.organizationId;
        if (typeof requested === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(requested.trim())) {
          organizationId = requested.trim();
        }
        const counts = new Map();
        const empRepo = db.getRepository('latticeEmployees');
        const empRows = empRepo ? await empRepo.find({ filter: { active: true }, fields: ['organizationId'], limit: 500 }) : [];
        for (const r of Array.isArray(empRows) ? empRows : []) {
          const oid = val(r, 'organizationId');
          if (oid) counts.set(oid, (counts.get(oid) || 0) + 1);
        }
        const deptRepo = db.getRepository('latticeDepartments');
        const deptRows = deptRepo ? await deptRepo.find({ filter: { active: true }, fields: ['organizationId'], limit: 200 }) : [];
        for (const r of Array.isArray(deptRows) ? deptRows : []) {
          const oid = val(r, 'organizationId');
          if (oid && !counts.has(oid)) counts.set(oid, 0);
        }
        organizations = [...counts.keys()].sort((a, b) => (counts.get(b) - counts.get(a)) || a.localeCompare(b));
      } else {
        const actor = await resolveParaActor(db, ctx.state?.currentUser);
        organizationId = actor.organizationId;
        organizations = [actor.organizationId];
      }

      const repo = db.getRepository('latticeParaDocuments');
      const filter = { active: true, ...(organizationId ? { organizationId } : {}) };
      const spaces = Object.fromEntries(PARA_SPACES.map((space) => [space, 0]));
      if (repo && typeof repo.count === 'function') {
        const counts = await Promise.all(
          PARA_SPACES.map((space) => repo.count({ filter: { ...filter, paraSpace: space } })),
        );
        PARA_SPACES.forEach((space, idx) => {
          spaces[space] = Number(counts[idx]) || 0;
        });
      } else {
        const rows = repo ? await repo.find({ filter, fields: ['id', 'paraSpace', 'active', 'organizationId'] }) : [];
        for (const row of Array.isArray(rows) ? rows : []) {
          if (val(row, 'active') === false) continue;
          const space = val(row, 'paraSpace') || 'projects';
          if (Object.hasOwn(spaces, space)) spaces[space] += 1;
        }
      }
      const total = Object.values(spaces).reduce((acc, n) => acc + n, 0);
      ctx.body = { organizationId, organizations, spaces, total };
      await next();
    },

    hybridSearch: async (ctx, next) => {
      if (!['GET', 'POST'].includes(ctx.method || 'GET')) ctx.throw(405);
      const isRoot = ctx.state?.currentRole === 'root';
      const p = ctx.action?.params || {};
      const v = p.values && typeof p.values === 'object' && !Array.isArray(p.values) ? p.values : {};
      const params = { ...p, ...v };

      let organizationId = null;
      if (isRoot) {
        if (!val(ctx.state?.currentUser, 'id')) ctx.throw(401, 'Yêu cầu đăng nhập.');
        const reqOrg = params.organizationId;
        if (typeof reqOrg === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(reqOrg.trim())) {
          organizationId = reqOrg.trim();
        }
      } else {
        const actor = await resolveParaActor(db, ctx.state?.currentUser);
        organizationId = actor.organizationId;
      }

      const rawSpace = params.paraSpace ? String(params.paraSpace).trim() : null;
      if (rawSpace && !PARA_SPACES.includes(rawSpace)) {
        ctx.throw(400, 'Phân vùng P.A.R.A. không hợp lệ.');
      }
      const query = String(params.query || '').trim().slice(0, 200);
      const limit = Math.max(1, Math.min(30, Number(params.limit) || 10));

      const items = await executeHybridSearch(db, {
        organizationId,
        query,
        paraSpace: rawSpace,
        limit,
      });
      ctx.body = {
        organizationId,
        engine: 'hybrid-rrf',
        query,
        paraSpace: rawSpace,
        count: items.length,
        items,
      };
      if (typeof next === 'function') await next();
    },
  };
}

module.exports = { createParaActions };
