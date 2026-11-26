/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const crypto = require('crypto');
const {
  ORG_ID_RE,
  assertPatScope,
  clampPageLimit,
  fail,
  isOrgAdmin,
  loadFoundationModule,
  readParams,
  resolveTenantActor,
  resolveVerifiedRoles,
  runWithOptionalRls,
  runWithSystemRlsBypass,
  toPlain,
  val,
} = require('./wms-dmn-shared');
const { upsertRepoRow } = require('./domain-portal-composer');

const ADMIN_ROLES = new Set(['ldx_admin', 'root', 'admin']);

async function generateOrEnsureOrgPkiKey(db, organizationId, env, opts = {}) {
  const effectiveEnv = env && typeof env === 'object' && env.env && typeof env.env === 'object'
    ? env.env
    : env || process.env;
  const rawSecret = String(
    effectiveEnv?.DX_VAULT_MASTER_KEY
      || effectiveEnv?.ENCRYPTION_FIELD_KEY
      || effectiveEnv?.NOCOBASE_APP_KEY
      || effectiveEnv?.APP_KEY
      || '',
  ).trim();
  const isProduction = String(effectiveEnv?.NODE_ENV || '').trim().toLowerCase() === 'production';

  if (isProduction && !rawSecret) {
    throw fail(
      'PKI_MASTER_KEY_MISSING',
      500,
      'DX_VAULT_MASTER_KEY, ENCRYPTION_FIELD_KEY, NOCOBASE_APP_KEY, or APP_KEY must be set in production.',
    );
  }

  const ledgerEnv = rawSecret && !effectiveEnv?.ENCRYPTION_FIELD_KEY && !effectiveEnv?.APP_KEY
    ? { ...effectiveEnv, ENCRYPTION_FIELD_KEY: rawSecret }
    : effectiveEnv;

  const pkiLedger = loadFoundationModule('pki-ledger');
  if (pkiLedger && typeof pkiLedger.ensureOrgSigningKey === 'function') {
    try {
      const res = await pkiLedger.ensureOrgSigningKey(db, organizationId, {
        env: ledgerEnv,
        ...(opts.transaction ? { transaction: opts.transaction } : {}),
      });
      if (res) return toPlain(res);
    } catch (err) {
      if (
        err?.code === 'PKI_MASTER_KEY_MISSING'
        || err?.code === 'PKI_KEY_INACTIVE'
        || err?.code === 'PKI_CIPHERTEXT_INVALID'
      ) {
        throw err;
      }
      // Fallback below if isolated unit test repository has custom shape
    }
  }

  const pkiRepo = db.getRepository?.('latticePkiKeys');
  if (!pkiRepo) return null;
  const runKeyOp = async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    const existing = await pkiRepo.findOne({ filter: { organizationId, active: true }, ...txOpt });
    if (existing) return toPlain(existing);

    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
    const fingerprintSha256 = crypto.createHash('sha256').update(spkiDer).digest('hex');
    const keyMaterial = rawSecret || 'lattice-dev-fallback-key';
    const aesKey = crypto.createHash('sha256').update(keyMaterial).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    const encrypted = Buffer.concat([cipher.update(privateKeyPem, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const encryptedPrivateKey = `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
    const keyId = `ed25519-${fingerprintSha256.slice(0, 16)}`;

    const created = await pkiRepo.create({
      values: {
        organizationId,
        keyId,
        algorithm: 'Ed25519',
        publicKeyPem,
        encryptedPrivateKey,
        fingerprintSha256,
        active: true,
      },
      ...txOpt,
    });
    return toPlain(created);
  };
  if (opts.transaction) return runKeyOp(opts.transaction);
  return runWithOptionalRls(db, organizationId, runKeyOp);
}

function assertBuilderPatScope(ctx, requiredScopes, foundation) {
  if (ctx?.state?.latticeApiKey) {
    return assertPatScope(ctx, requiredScopes, foundation);
  }
  const rawPatScopes = ctx?.state?.patScopes || ctx?.state?.currentUser?.patScopes || ctx?.state?.apiKey?.scopes;
  const isLegacyPat = ctx?.state?.authType === 'pat' || Boolean(ctx?.state?.apiKey) || rawPatScopes !== undefined;
  if (!isLegacyPat) return true;
  const heldList = Array.isArray(rawPatScopes)
    ? rawPatScopes
    : typeof rawPatScopes === 'string'
      ? rawPatScopes.split(',')
      : [];
  const held = new Set(heldList.map((s) => String(s).trim().toLowerCase()).filter(Boolean));
  const needed = Array.isArray(requiredScopes) ? requiredScopes : [requiredScopes];
  if (needed.some((s) => held.has(String(s).toLowerCase()))) return true;
  throw fail('API_KEY_SCOPE_INSUFFICIENT', 403, `API key lacks required scope (${needed.join(' or ')}).`);
}

function createRequireBuilderAdmin(db, foundation) {
  return async function requireBuilderAdmin(ctx, params, { requireOrg = true, rootOnly = false, patScopes = null } = {}) {
    const userId = val(ctx?.state?.currentUser, 'id');
    if (userId == null || !/^[1-9]\d*$/.test(String(userId))) {
      throw fail('NATIVE_LOGIN_REQUIRED', 401, 'Yêu cầu đăng nhập.');
    }
    assertBuilderPatScope(ctx, patScopes || (rootOnly ? ['write'] : ['read', 'write']), foundation);

    const roles = await resolveVerifiedRoles(db, ctx);
    const ruRepo = db?.getRepository?.('rolesUsers');
    const hasRuRepo = Boolean(ruRepo && typeof ruRepo.find === 'function');
    const isRoot = roles.includes('root') || (!hasRuRepo && ctx?.state?.currentUser?.isRoot === true);

    if ((rootOnly || ctx?.state?.currentRole === 'root') && !isRoot) {
      throw fail('ROOT_ADMIN_REQUIRED', 403, 'Verified root role required for DX-OS Studio builder mutations');
    }

    const orgAdmin = await isOrgAdmin(db, ctx);
    const allowed = isRoot || roles.some((r) => ADMIN_ROLES.has(String(r))) || orgAdmin;
    if (!allowed) {
      throw fail('FORBIDDEN', 403, 'Verified root or ldx_admin role required for DX-OS Studio builder');
    }

    const rawReqOrg = params.organizationId ?? params.tenantId ?? null;
    const requestedOrgId = rawReqOrg != null ? String(rawReqOrg).trim() || null : null;
    const { organizationId, actor } = await resolveTenantActor(
      db,
      ctx,
      {
        requireOrg,
        requestedOrgId,
        aclCollections: [],
      },
      foundation,
    );
    return { organizationId, actor, roles, isRoot };
  };
}

async function listTenantsAction(db, ctx, next, { foundation, requireBuilderAdmin }) {
  const params = readParams(ctx);
  const { organizationId, isRoot } = await requireBuilderAdmin(ctx, params, {
    requireOrg: false,
    rootOnly: false,
    patScopes: ['read', 'write'],
  });

  const orgRepo = db.getRepository?.('latticeOrganizations');
  const deptRepo = db.getRepository?.('latticeDepartments');
  const empRepo = db.getRepository?.('latticeEmployees');
  const pkiRepo = db.getRepository?.('latticePkiKeys');
  const slaRepo = db.getRepository?.('latticeSlaPolicies');

  const { limit, offset } = clampPageLimit(params);
  let orgRows = orgRepo ? await orgRepo.find({ sort: ['organizationId'], limit, offset }) : [];
  if (!isRoot) {
    orgRows = (Array.isArray(orgRows) ? orgRows : []).filter(
      (o) => val(o, 'organizationId') === organizationId,
    );
  }

  const runTenantsRls = (fn) => (
    isRoot
      ? runWithSystemRlsBypass(db, fn, foundation)
      : runWithOptionalRls(db, organizationId, fn, foundation)
  );
  const items = await runTenantsRls(async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    const out = [];
    for (const row of Array.isArray(orgRows) ? orgRows : []) {
      const plain = toPlain(row);
      const orgId = plain.organizationId;
      const depts = deptRepo ? await deptRepo.find({ filter: { organizationId: orgId }, limit: 200, ...txOpt }) : [];
      const emps = empRepo ? await empRepo.find({ filter: { organizationId: orgId }, limit: 500, ...txOpt }) : [];
      const pki = pkiRepo ? await pkiRepo.findOne({ filter: { organizationId: orgId, active: true }, ...txOpt }) : null;
      const slas = slaRepo ? await slaRepo.find({ filter: { organizationId: orgId }, limit: 200, ...txOpt }) : [];

      const pkiActive = pki ? val(pki, 'active') !== false && val(pki, 'status') !== 'inactive' : false;
      out.push({
        ...plain,
        departmentCount: Array.isArray(depts) ? depts.length : 0,
        employeeCount: Array.isArray(emps) ? emps.length : 0,
        activePkiKey: pki
          ? {
              keyId: val(pki, 'keyId'),
              algorithm: val(pki, 'algorithm'),
              active: pkiActive,
              status: val(pki, 'status') || (pkiActive ? 'active' : 'inactive'),
            }
          : null,
        slaCount: Array.isArray(slas) ? slas.length : 0,
      });
    }
    return out;
  });
  ctx.body = { items };
  return next();
}

async function provisionTenantAction(db, ctx, next, { foundation, options = {}, requireBuilderAdmin }) {
  const params = readParams(ctx);
  const organizationId = String(params.organizationId || params.tenantId || '').trim();
  if (!ORG_ID_RE.test(organizationId) || organizationId.toLowerCase() === 'all') {
    throw fail('INVALID_ORGANIZATION_ID', 400, 'organizationId must match ^[a-zA-Z0-9][a-zA-Z0-9_-]{1,62}$');
  }
  await requireBuilderAdmin(ctx, params, { requireOrg: true, rootOnly: true, patScopes: ['write'] });
  const name = String(params.name || organizationId).trim();
  const region = String(params.region || 'VN').trim() || 'VN';

  const orgRepo = db.getRepository?.('latticeOrganizations');
  const deptRepo = db.getRepository?.('latticeDepartments');
  const locRepo = db.getRepository?.('latticeLocations');
  const slaRepo = db.getRepository?.('latticeSlaPolicies');

  const { orgRow, departments, locations, pkiKey, slas } = await runWithOptionalRls(db, organizationId, async (transaction) => {
    const savedOrg = orgRepo
      ? await upsertRepoRow(
          orgRepo,
          { organizationId },
          { organizationId, name, region, status: 'active', active: true },
          transaction,
        )
      : { organizationId, name, region, status: 'active', active: true };

    const savedDepts = [];
    if (deptRepo) {
      const defaultDepts = [
        { code: 'ops', name: 'Operations', organizationId, active: true },
        { code: 'maint', name: 'Maintenance & Cold-Chain', organizationId, active: true },
      ];
      for (const dept of defaultDepts) {
        savedDepts.push(toPlain(await upsertRepoRow(deptRepo, { organizationId, code: dept.code }, dept, transaction)));
      }
    }

    const savedLocs = [];
    if (locRepo) {
      const primaryDeptId = savedDepts[0]?.id ?? null;
      const defaultLocs = [
        {
          code: 'hq',
          name: `${name} HQ`,
          organizationId,
          kind: 'headquarters',
          departmentId: primaryDeptId,
          active: true,
        },
      ];
      for (const loc of defaultLocs) {
        savedLocs.push(toPlain(await upsertRepoRow(locRepo, { organizationId, code: loc.code }, loc, transaction)));
      }
    }

    const savedPkiKey = await generateOrEnsureOrgPkiKey(db, organizationId, options.env, { transaction });

    const savedSlas = [];
    if (slaRepo) {
      const defaultSlas = [
        {
          organizationId,
          targetCollection: 'latticeServiceTickets',
          priority: 'urgent',
          warnAfterMinutes: 60,
          breachAfterMinutes: 240,
          escalateToRole: 'ldx_manager',
          notifyChannels: ['in_app'],
          active: true,
        },
        {
          organizationId,
          targetCollection: 'latticeServiceTickets',
          priority: 'high',
          warnAfterMinutes: 120,
          breachAfterMinutes: 480,
          escalateToRole: 'ldx_manager',
          notifyChannels: ['in_app'],
          active: true,
        },
        {
          organizationId,
          targetCollection: 'latticeServiceTickets',
          priority: 'normal',
          warnAfterMinutes: 480,
          breachAfterMinutes: 1440,
          escalateToRole: 'ldx_manager',
          notifyChannels: ['in_app'],
          active: true,
        },
        {
          organizationId,
          targetCollection: 'latticeIncidentCases',
          priority: 'critical',
          warnAfterMinutes: 15,
          breachAfterMinutes: 60,
          escalateToRole: 'ldx_manager',
          notifyChannels: ['in_app'],
          active: true,
        },
      ];
      for (const sla of defaultSlas) {
        savedSlas.push(
          toPlain(
            await upsertRepoRow(
              slaRepo,
              {
                organizationId: sla.organizationId,
                targetCollection: sla.targetCollection,
                priority: sla.priority,
              },
              sla,
              transaction,
            ),
          ),
        );
      }
    }

    return { orgRow: savedOrg, departments: savedDepts, locations: savedLocs, pkiKey: savedPkiKey, slas: savedSlas };
  }, foundation);

  let adminAccount = null;
  const adminUsername = params.adminUsername ? String(params.adminUsername).trim() : '';
  const adminEmail = params.adminEmail ? String(params.adminEmail).trim() : '';
  if (adminUsername || adminEmail) {
    adminAccount = await runWithSystemRlsBypass(db, async (transaction) => {
      const txOpt = transaction ? { transaction } : {};
      const usersRepo = db.getRepository?.('users');
      const rolesUsersRepo = db.getRepository?.('rolesUsers');
      const empRepo = db.getRepository?.('latticeEmployees');
      const resolvedUsername = adminUsername || (adminEmail.includes('@') ? adminEmail.split('@')[0] : adminEmail);
      const resolvedEmail = adminEmail || `${resolvedUsername}@${organizationId}.local`;
      let userRow = null;
      let createdNewUser = false;
      let generatedTempPassword = null;

      if (usersRepo) {
        const byUsername = adminUsername ? await usersRepo.findOne({ filter: { username: adminUsername }, ...txOpt }) : null;
        const byEmail = adminEmail ? await usersRepo.findOne({ filter: { email: adminEmail }, ...txOpt }) : null;
        if (byUsername && byEmail && val(byUsername, 'id') !== val(byEmail, 'id')) {
          throw fail('USER_ORG_CONFLICT', 403, 'adminUsername and adminEmail resolve to different existing users');
        }
        userRow = byUsername || byEmail || null;
        if (!userRow && resolvedUsername && resolvedUsername !== adminUsername) {
          userRow = await usersRepo.findOne({ filter: { username: resolvedUsername }, ...txOpt });
        }
        if (!userRow && resolvedEmail && resolvedEmail !== adminEmail) {
          userRow = await usersRepo.findOne({ filter: { email: resolvedEmail }, ...txOpt });
        }

        if (userRow) {
          const existingUserId = val(userRow, 'id');
          const legacyUserOrg = val(userRow, 'organizationId');
          if (legacyUserOrg && legacyUserOrg !== organizationId) {
            throw fail('USER_ORG_CONFLICT', 403, `User "${val(userRow, 'username') || resolvedUsername}" belongs to another organization`);
          }
          if (rolesUsersRepo && existingUserId != null) {
            let roleBindings = [];
            if (typeof rolesUsersRepo.find === 'function') {
              roleBindings = (await rolesUsersRepo.find({ filter: { userId: existingUserId }, ...txOpt })) || [];
            } else if (typeof rolesUsersRepo.findOne === 'function') {
              const rootRow = await rolesUsersRepo.findOne({ filter: { userId: existingUserId, roleName: 'root' }, ...txOpt });
              const adminRow = await rolesUsersRepo.findOne({ filter: { userId: existingUserId, roleName: 'admin' }, ...txOpt });
              roleBindings = [rootRow, adminRow].filter(Boolean);
            }
            const holdsPrivilegedRole = roleBindings.some((ru) => {
              const rUserId = val(ru, 'userId');
              if (rUserId != null && String(rUserId) !== String(existingUserId)) return false;
              const rName = String(val(ru, 'roleName') || '').trim().toLowerCase();
              return rName === 'root' || rName === 'admin';
            });
            if (holdsPrivilegedRole) {
              throw fail(
                'USER_ORG_CONFLICT',
                403,
                `Privileged user "${val(userRow, 'username') || resolvedUsername}" cannot be attached to tenant "${organizationId}"`,
              );
            }
          }
          if (!empRepo || typeof empRepo.find !== 'function') {
            throw fail(
              'USER_ORG_CONFLICT',
              403,
              `Cannot verify organization membership for existing user "${val(userRow, 'username') || resolvedUsername}"`,
            );
          }
          const empRows = (await empRepo.find({ filter: { userId: existingUserId }, limit: 100, ...txOpt })) || [];
          const ownedRows = empRows.filter((e) => {
            const eUserId = val(e, 'userId');
            return eUserId == null || String(eUserId) === String(existingUserId);
          });
          if (ownedRows.length === 0 || ownedRows.some((e) => val(e, 'organizationId') !== organizationId)) {
            throw fail(
              'USER_ORG_CONFLICT',
              403,
              `User "${val(userRow, 'username') || resolvedUsername}" belongs to another organization or lacks membership in "${organizationId}"`,
            );
          }
        } else {
          const hasExplicitPassword =
            params.adminPassword !== undefined && params.adminPassword !== null && String(params.adminPassword) !== '';
          const rawPwd = hasExplicitPassword
            ? String(params.adminPassword)
            : crypto.randomBytes(18).toString('base64url');
          userRow = await usersRepo.create({
            values: {
              username: resolvedUsername,
              email: resolvedEmail,
              nickname: params.adminNickname || resolvedUsername || 'Tenant Admin',
              password: rawPwd,
              roles: ['ldx_admin'],
            },
            ...txOpt,
          });
          createdNewUser = true;
          if (!hasExplicitPassword) {
            generatedTempPassword = rawPwd;
          }
        }
      }

      const userId = val(userRow, 'id') ?? null;
      if (rolesUsersRepo && userId != null) {
        await upsertRepoRow(
          rolesUsersRepo,
          { roleName: 'ldx_admin', userId },
          { roleName: 'ldx_admin', userId },
          transaction,
        );
      }
      let employeeRow = null;
      if (empRepo) {
        const empCode = `emp_admin_${organizationId}`;
        employeeRow = await upsertRepoRow(
          empRepo,
          { organizationId, code: empCode },
          {
            organizationId,
            code: empCode,
            name: params.adminNickname || resolvedUsername || 'Tenant Admin',
            email: resolvedEmail,
            userId,
            departmentId: departments[0]?.id ?? null,
            active: true,
          },
          transaction,
        );
      }
      return {
        userId,
        username: val(userRow, 'username') || resolvedUsername,
        email: val(userRow, 'email') || resolvedEmail,
        role: 'ldx_admin',
        employeeId: val(employeeRow, 'id') ?? null,
        ...(createdNewUser && generatedTempPassword ? { tempPassword: generatedTempPassword } : {}),
      };
    }, foundation);
  }

  ctx.body = {
    provisioned: true,
    organization: toPlain(orgRow),
    departmentsCount: departments.length,
    locationsCount: locations.length,
    pkiKey: pkiKey
      ? {
          keyId: pkiKey.keyId,
          algorithm: pkiKey.algorithm,
          active: pkiKey.active !== false,
          status: pkiKey.status || (pkiKey.active === false ? 'inactive' : 'active'),
        }
      : null,
    slaCount: slas.length,
    adminAccount,
  };
  return next();
}

module.exports = {
  ADMIN_ROLES,
  assertBuilderPatScope,
  createRequireBuilderAdmin,
  generateOrEnsureOrgPkiKey,
  listTenantsAction,
  provisionTenantAction,
};
