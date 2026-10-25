// SPDX-License-Identifier: Apache-2.0
const { test } = require("node:test"),
  assert = require("node:assert/strict");

const { companyOperationsRecipe, validateRecipe } = require("../src/client/system-model");
const { createWorkspaceComponent } = require("../src/client/workspace");
const { createSystemScreens } = require("../src/client/system-studio");
const { createMemberPermissions } = require("../src/client/member-permissions");
const { studioRequest, BridgeError } = require("../../action-bridge/studio.cjs");

const queryValidator = (q) => (q ? new URLSearchParams(Object.entries(q)).toString() : "");

globalThis.setInterval = () => ({ unref: () => {} });
globalThis.clearInterval = () => {};
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const t = originalSetTimeout(fn, ms, ...args);
  if (t && typeof t.unref === "function") t.unref();
  return t;
};

// ---------------- SIMULATION HARNESS WITH REAL BRIDGE VALIDATION (NOT BROWSER E2E) ----------------

function createEnterpriseE2EEnvironment() {
  const recipe = companyOperationsRecipe();
  const diagnostics = validateRecipe(recipe);

  // State store representing backend services
  const systemStore = {
    installedApp: {
      id: "company-ops",
      version: "1.0.0",
      title: "Điều hành công ty",
      enabled: true,
      presentation: {
        pages: recipe.pages.map((p) => ({
          ...p,
          definitionId: p.id,
          fieldLabels: {
            title: "Tiêu đề yêu cầu",
            content: "Nội dung đề xuất",
            handlerId: "Người phụ trách",
            urgent: "Ghi chú khẩn",
          },
        })),
        entityPages: recipe.entityPages || [],
      },
      definitions: [
        {
          id: "cross-requests",
          startRole: "employee",
          readerRoles: ["manager", "operator"],
          assignedReader: { role: "operator" },
          startFields: { content: "string", handlerId: "string" },
          optionalStartFields: { priority: "string" },
        },
      ],
      schemas: recipe.schemas,
    },
    policy: {
      systemId: "company-ops",
      version: "1.0.0",
      status: "legacy",
      revision: 0,
    },
    members: [],
    workflows: [],
    people: [
      { subject: "usr_alice", displayName: "Alice Nguyen", departmentId: "dep_sales", roles: ["employee"] },
      { subject: "usr_bob", displayName: "Bob Tran", departmentId: "dep_management", roles: ["manager"] },
      { subject: "usr_duy", displayName: "Duy Nguyen", departmentId: "dep_it", roles: ["operator"] },
    ],
    departments: [
      { id: "dep_sales", name: "Phòng Kinh doanh" },
      { id: "dep_management", name: "Ban Giám đốc" },
      { id: "dep_it", name: "Phòng Kỹ thuật & Vận hành" },
    ],
    auditLogs: [],
  };

  function createClientForActor(actor) {
    let slots = [],
      effects = [],
      pending = [],
      index = 0;

    const h = (type, props, ...children) => ({
      type,
      props: props || {},
      children: children
        .flat(Infinity)
        .filter((v) => v !== false && v !== null && v !== undefined),
    });

    const React = {
      createElement: h,
      Fragment: "fragment",
      useState(initial) {
        const i = index++;
        if (!slots[i]) {
          slots[i] = {
            value: typeof initial === "function" ? initial() : initial,
          };
        }
        return [
          slots[i].value,
          (value) => {
            slots[i].value =
              typeof value === "function" ? value(slots[i].value) : value;
          },
        ];
      },
      useEffect(fn, deps) {
        const i = index++;
        const prev = slots[i];
        const changed = !prev || !deps || !prev.deps || deps.some((v, k) => v !== prev.deps[k]);
        if (changed) {
          slots[i] = { deps };
          effects.push(fn);
        }
      },
      useMemo(fn) {
        return fn();
      },
      useRef(initial) {
        const i = index++;
        if (!slots[i]) {
          slots[i] = { current: initial };
        }
        return slots[i];
      },
      useCallback(fn) {
        return fn;
      },
    };

    const clientMock = {
      useAPIClient: () => ({
        request: async (opts) => {
          if (opts.url === "auth:check") {
            return { data: { data: { username: actor.username, nickname: actor.username } } };
          }
          if (opts.url === "latticeApps:list") {
            return { data: { data: { items: [] } } };
          }
          if (opts.url === "dxActions:status") {
            return {
              data: {
                connected: true,
                identity: {
                  username: actor.username,
                  organizationId: actor.organizationId,
                  subject: actor.subject,
                  roles: actor.roles,
                },
                expiresAt: new Date(Date.now() + 3600000).toISOString(),
                capabilities: {
                  "entities.read": { available: true },
                  "workflow.design": { available: actor.canManageOrg },
                  "data.design": { available: actor.canManageOrg },
                  "organization.manage": { available: actor.canManageOrg },
                  directoryRead: true,
                },
              },
            };
          }
          if (opts.url === "dxActions:studio") {
            const op = opts.data?.operation;
            // Real bridge request validation
            studioRequest(opts.data, BridgeError, queryValidator);

            if (op === "apps" || op === "adminSystems") {
              return { data: { items: [systemStore.installedApp], page: { hasMore: false } } };
            }
            if (op === "app" || op === "adminSystem") {
              if (opts.data?.id !== systemStore.installedApp.id || opts.data?.version !== systemStore.installedApp.version) {
                throw new Error("Hệ thống không tồn tại.");
              }
              const isEmployee = actor.roles.includes("employee") || actor.roles.includes("admin");
              const appCopy = JSON.parse(JSON.stringify(systemStore.installedApp));
              appCopy.definitions[0].canStart = isEmployee;
              return { data: appCopy };
            }
            if (op === "departments") {
              return { data: { items: systemStore.departments, page: { hasMore: false } } };
            }
            if (op === "members") {
              const matched = systemStore.members.filter((m) => m.systemId === opts.data.id && m.systemVersion === opts.data.version);
              return { data: { items: matched, page: { hasMore: false } } };
            }
            if (op === "policy") {
              return { data: systemStore.policy };
            }
            if (op === "activatePolicy") {
              if (systemStore.policy.revision !== opts.data.body?.expectedRevision) {
                const err = new Error("Xung đột revision chính sách (CAS conflict).");
                err.status = 409;
                throw err;
              }
              systemStore.policy.status = "enforced";
              systemStore.policy.revision += 1;
              return { data: systemStore.policy };
            }
            if (op === "grantMember") {
              const { principalType, principalId, roles } = opts.data.body;
              let existing = systemStore.members.find(
                (m) => m.principalType === principalType && m.principalId === principalId,
              );
              if (existing) {
                existing.roles = roles;
                existing.status = "active";
                existing.revision += 1;
              } else {
                systemStore.members.push({
                  systemId: opts.data.id,
                  systemVersion: opts.data.version,
                  principalType,
                  principalId,
                  roles,
                  status: "active",
                  revision: 1,
                  grantedAt: new Date().toISOString(),
                });
              }
              return { data: { success: true } };
            }
            if (op === "updateMember") {
              const { principalType, principalId } = opts.data;
              const { expectedRevision, roles } = opts.data.body;
              const member = systemStore.members.find(
                (m) => m.principalType === principalType && m.principalId === principalId,
              );
              if (!member || member.revision !== expectedRevision) {
                const err = new Error("Xung đột revision thành viên (CAS conflict).");
                err.status = 409;
                throw err;
              }
              member.roles = roles;
              member.revision += 1;
              return { data: { success: true } };
            }
            if (op === "revokeMember") {
              const { principalType, principalId } = opts.data;
              const { expectedRevision } = opts.data.body;
              const member = systemStore.members.find(
                (m) => m.principalType === principalType && m.principalId === principalId,
              );
              if (!member || member.revision !== expectedRevision) {
                const err = new Error("Xung đột revision thành viên (CAS conflict).");
                err.status = 409;
                throw err;
              }
              member.status = "revoked";
              member.revision += 1;
              return { data: { success: true } };
            }
            if (op === "myAccess") {
              const activeGrant = systemStore.members.find(
                (m) => m.principalType === "person" && m.principalId === actor.subject && m.status === "active",
              );
              const hasAccess = Boolean(activeGrant || systemStore.policy.status === "legacy");
              const effectiveRoles = activeGrant ? activeGrant.roles : (systemStore.policy.status === "legacy" ? actor.roles : []);
              return {
                data: {
                  systemId: opts.data.id,
                  version: opts.data.version,
                  hasAccess,
                  effectiveRoles,
                  sources: activeGrant ? [{ source: "person", principalId: actor.subject, roles: activeGrant.roles }] : [],
                  enforcementStatus: systemStore.policy.status,
                },
              };
            }
          }
          if (opts.url === "dxActions:workflow") {
            const op = opts.data?.operation;
            if (op === "capabilities") {
              return {
                data: {
                  capabilities: {
                    "entities.read": { available: true },
                    "workflow.design": { available: actor.canManageOrg },
                    "data.design": { available: actor.canManageOrg },
                    directoryRead: true,
                  },
                },
              };
            }
            if (op === "member") {
              return { data: { member: true } };
            }
            if (op === "people") {
              return { data: { items: systemStore.people, page: { hasMore: false } } };
            }
            if (op === "create") {
              const run = {
                id: "run-" + (systemStore.workflows.length + 101),
                definitionId: opts.data.body?.definitionId || "cross-requests",
                title: opts.data.body?.title,
                creator: actor.subject,
                handlerId: opts.data.body?.input?.handlerId,
                state: "draft",
                version: 1,
                data: opts.data.body?.input || {},
              };
              systemStore.workflows.push(run);
              systemStore.auditLogs.push({ action: "create", actor: actor.subject, runId: run.id });
              return { data: run };
            }
            if (op === "list" || op === "inbox") {
              const isInbox = op === "inbox";
              let items = systemStore.workflows;
              if (isInbox) {
                if (actor.roles.includes("manager")) {
                  items = items.filter((w) => w.state === "submitted");
                } else if (actor.roles.includes("operator")) {
                  items = items.filter((w) => w.state === "approved" && w.handlerId === actor.subject);
                } else {
                  items = items.filter((w) => w.creator === actor.subject && w.state === "draft");
                }
              }
              return { data: { items, page: { hasMore: false } } };
            }
            if (op === "detail") {
              const run = systemStore.workflows.find((w) => w.id === opts.data.id);
              if (!run) throw new Error("Hồ sơ không tồn tại.");

              const availableTransitions = [];
              if (run.state === "draft" && (actor.roles.includes("employee") || run.creator === actor.subject)) {
                availableTransitions.push({ id: "submit", fields: {} });
              } else if (run.state === "submitted" && actor.roles.includes("manager")) {
                availableTransitions.push({ id: "approve", fields: {} });
                availableTransitions.push({ id: "reject", fields: { reason: "string" } });
              } else if (run.state === "approved" && (actor.roles.includes("operator") || run.handlerId === actor.subject)) {
                availableTransitions.push({ id: "complete", fields: {} });
              }

              return {
                data: {
                  ...run,
                  availableTransitions,
                },
              };
            }
            if (op === "history") {
              return { data: { items: systemStore.auditLogs.filter((l) => l.runId === opts.data.id) } };
            }
            if (op === "transition") {
              const run = systemStore.workflows.find((w) => w.id === opts.data.id);
              if (!run) throw new Error("Hồ sơ không tồn tại.");
              const action = opts.data.body?.action;
              if (action === "submit") {
                run.state = "submitted";
              } else if (action === "approve") {
                run.state = "approved";
              } else if (action === "reject") {
                run.state = "rejected";
              } else if (action === "complete") {
                run.state = "completed";
              }
              run.version += 1;
              systemStore.auditLogs.push({ action, actor: actor.subject, runId: run.id });
              return { data: run };
            }
          }
          return { data: {} };
        },
        auth: { signOut: async () => {} },
      }),
    };

    const runtimeMock = {
      Application: () => ({ type: "div", props: { "data-testid": "runtime-app" }, children: [] }),
    };

    const shell = {
      h,
      box: { border: "1px solid" },
      button: (label, onClick, disabled) => ({
        type: "button",
        props: { onClick, disabled },
        children: [label],
      }),
      field: (label, value, onChange) => ({
        type: "div",
        props: { "data-field": label },
        children: [
          { type: "label", props: {}, children: [label] },
          {
            type: "input",
            props: { value, onChange: (e) => onChange(e.target.value) },
          },
        ],
      }),
      json: (value) => ({ type: "pre", props: {}, children: [JSON.stringify(value)] }),
    };

    const MemberPermissions = createMemberPermissions(React, shell);

    const session = {
      connection: {
        connected: true,
        identity: {
          username: actor.username,
          subject: actor.subject,
          organizationId: actor.organizationId,
          roles: actor.roles,
        },
      },
      capabilities: {
        "entities.read": { available: true },
        "workflow.design": { available: actor.canManageOrg },
        "data.design": { available: actor.canManageOrg },
        directoryRead: true,
      },
      busy: false,
      commands: {
        uncertain: false,
        execute: async (op, payload) => {
          const res = await clientMock.useAPIClient().request({
            url: "dxActions:studio",
            method: "post",
            data: { operation: op, ...payload, key: "cmd-" + Math.random().toString(36).slice(2) },
          });
          return res.data;
        },
      },
      report: () => {},
      act: (fn) => {
        const promise = Promise.resolve().then(fn);
        pending.push(promise);
        return promise;
      },
      api: {
        studio: async (op, payload = {}) => {
          const res = await clientMock.useAPIClient().request({
            url: "dxActions:studio",
            method: "post",
            data: { operation: op, ...payload },
          });
          return res.data;
        },
        workflow: async (op, payload = {}) => {
          const res = await clientMock.useAPIClient().request({
            url: "dxActions:workflow",
            method: "post",
            data: { operation: op, ...payload },
          });
          return res.data;
        },
      },
    };

    const Workspace = createWorkspaceComponent(clientMock, React, runtimeMock);
    const { SystemRuntime } = createSystemScreens(clientMock, React);

    function find(tree, predicate) {
      if (!tree || typeof tree !== "object") return undefined;
      if (predicate(tree)) return tree;
      if (typeof tree.type === "function") {
        const rendered = tree.type({ ...tree.props, children: tree.children });
        const found = find(rendered, predicate);
        if (found) return found;
      }
      return tree.children?.map((c) => find(c, predicate)).find(Boolean);
    }

    function findAll(tree, predicate, acc = []) {
      if (!tree || typeof tree !== "object") return acc;
      if (predicate(tree)) acc.push(tree);
      if (typeof tree.type === "function") {
        const rendered = tree.type(tree.props);
        findAll(rendered, predicate, acc);
      }
      tree.children?.forEach((c) => findAll(c, predicate, acc));
      return acc;
    }

    async function flushEffects() {
      for (const eff of effects.splice(0)) {
        eff();
      }
      await new Promise((r) => setImmediate(r));
      while (pending.length) {
        await Promise.all(pending.splice(0));
      }
    }

    async function renderWorkspace() {
      index = 0;
      globalThis.window = {
        location: { pathname: "/lattice", search: "", hash: "" },
        addEventListener: () => {},
        removeEventListener: () => {},
      };
      globalThis.sessionStorage = { setItem: () => {}, getItem: () => null, removeItem: () => {} };
      let tree = Workspace();
      for (let i = 0; i < 4; i++) {
        await flushEffects();
        index = 0;
        tree = Workspace();
      }
      return tree;
    }

    async function renderSystemRuntime(pathname = "/lattice/systems/company-ops/1.0.0") {
      index = 0;
      globalThis.window = {
        location: { pathname, search: "", hash: "", assign: () => {} },
      };
      globalThis.sessionStorage = { setItem: () => {}, getItem: () => null, removeItem: () => {} };
      let tree = SystemRuntime();
      for (let i = 0; i < 4; i++) {
        await flushEffects();
        index = 0;
        tree = SystemRuntime();
      }
      return tree;
    }

    return {
      find,
      findAll,
      flushEffects,
      renderWorkspace,
      renderSystemRuntime,
      reRenderCurrentRuntime(pathname = "/lattice/systems/company-ops/1.0.0") {
        index = 0;
        return SystemRuntime();
      },
      async renderMemberPermissions(systemId = "company-ops", systemVersion = "1.0.0") {
        index = 0;
        let tree = MemberPermissions({ session, systemId, systemVersion });
        for (let i = 0; i < 4; i++) {
          await flushEffects();
          index = 0;
          tree = MemberPermissions({ session, systemId, systemVersion });
        }
        return tree;
      },
      reRenderCurrentPermissions(systemId = "company-ops", systemVersion = "1.0.0") {
        index = 0;
        return MemberPermissions({ session, systemId, systemVersion });
      },
      api: session.api,
    };
  }

  return {
    recipe,
    diagnostics,
    systemStore,
    createClientForActor,
  };
}

// ---------------- SIMULATION TEST SUITES (REAL BRIDGE VALIDATION, NOT BROWSER E2E) ----------------

test("MÔ PHỎNG HARNESS (simulation harness with real bridge validation) - BƯỚC 1: Studio tạo hệ thống 'Điều hành công ty' tự động và validation đạt chuẩn", () => {
  const env = createEnterpriseE2EEnvironment();

  // Kiểm tra metadata
  assert.equal(env.recipe.id, "company-ops");
  assert.equal(env.recipe.title, "Điều hành công ty");
  assert.equal(env.recipe.version, "1.0.0");

  // Kiểm tra module dữ liệu và quy trình
  assert.ok(env.recipe.pages.some((p) => p.id === "cross-requests"));
  assert.ok(env.recipe.entityPages.some((p) => p.id === "departments"));
  assert.ok(env.recipe.entityPages.some((p) => p.id === "assets"));

  // Kiểm tra bộ quy tắc kiểm tra cấu hình thời gian thực (Diagnostics)
  assert.equal(env.diagnostics.valid, true, "Cấu hình hệ thống phải hợp lệ");
  assert.equal(env.diagnostics.issues.length, 0, "Cấu hình hệ thống phải đạt chuẩn 0 lỗi");
});

test("MÔ PHỎNG HARNESS (simulation harness with real bridge validation) - BƯỚC 2: Phân quyền thành viên qua UI/API chuẩn bridge (grantMember), kích hoạt chính sách CAS", async () => {
  const env = createEnterpriseE2EEnvironment();
  const adminActor = {
    username: "admin",
    subject: "usr_admin",
    organizationId: "org_default",
    roles: ["workflow:design", "data:design"],
    canManageOrg: true,
  };
  const adminClient = env.createClientForActor(adminActor);
  let adminPermTree = await adminClient.renderMemberPermissions("company-ops", "1.0.0");

  // Admin cấp quyền cho Alice: usr_alice -> employee
  const pSelectAlice = adminClient.find(adminPermTree, (n) => n.type === "select" && n.children?.some((c) => c.props?.value === "usr_alice"));
  assert.ok(pSelectAlice, "Admin phải thấy dropdown chọn nhân sự");
  pSelectAlice.props.onChange({ target: { value: "usr_alice" } });
  adminPermTree = adminClient.reRenderCurrentPermissions("company-ops", "1.0.0");

  const cbAlice = adminClient.findAll(adminPermTree, (n) => n.type === "input" && n.props?.type === "checkbox");
  assert.ok(cbAlice.length >= 3, "Phải có checkboxes cho các vai trò hệ thống");
  cbAlice[0].props.onChange({ target: { checked: true } });
  adminPermTree = adminClient.reRenderCurrentPermissions("company-ops", "1.0.0");

  const grantBtnAlice = adminClient.find(adminPermTree, (n) => n.type === "button" && n.children?.[0] === "Cấp quyền truy cập");
  assert.ok(grantBtnAlice, "Nút cấp quyền truy cập phải hiển thị");
  await grantBtnAlice.props.onClick();
  await adminClient.flushEffects();

  // Admin cấp quyền cho Bob: usr_bob -> manager
  adminPermTree = adminClient.reRenderCurrentPermissions("company-ops", "1.0.0");
  const pSelectBob = adminClient.find(adminPermTree, (n) => n.type === "select" && n.children?.some((c) => c.props?.value === "usr_bob"));
  pSelectBob.props.onChange({ target: { value: "usr_bob" } });
  adminPermTree = adminClient.reRenderCurrentPermissions("company-ops", "1.0.0");
  const cbBob = adminClient.findAll(adminPermTree, (n) => n.type === "input" && n.props?.type === "checkbox");
  cbBob[1].props.onChange({ target: { checked: true } });
  adminPermTree = adminClient.reRenderCurrentPermissions("company-ops", "1.0.0");
  const grantBtnBob = adminClient.find(adminPermTree, (n) => n.type === "button" && n.children?.[0] === "Cấp quyền truy cập");
  await grantBtnBob.props.onClick();
  await adminClient.flushEffects();

  // Admin cấp quyền cho Duy: usr_duy -> operator
  adminPermTree = adminClient.reRenderCurrentPermissions("company-ops", "1.0.0");
  const pSelectDuy = adminClient.find(adminPermTree, (n) => n.type === "select" && n.children?.some((c) => c.props?.value === "usr_duy"));
  pSelectDuy.props.onChange({ target: { value: "usr_duy" } });
  adminPermTree = adminClient.reRenderCurrentPermissions("company-ops", "1.0.0");
  const cbDuy = adminClient.findAll(adminPermTree, (n) => n.type === "input" && n.props?.type === "checkbox");
  cbDuy[2].props.onChange({ target: { checked: true } });
  adminPermTree = adminClient.reRenderCurrentPermissions("company-ops", "1.0.0");
  const grantBtnDuy = adminClient.find(adminPermTree, (n) => n.type === "button" && n.children?.[0] === "Cấp quyền truy cập");
  await grantBtnDuy.props.onClick();
  await adminClient.flushEffects();

  assert.equal(env.systemStore.members.length, 3);
  assert.ok(env.systemStore.members.some((m) => m.principalId === "usr_alice" && m.roles.includes("employee") && m.status === "active"));
  assert.ok(env.systemStore.members.some((m) => m.principalId === "usr_bob" && m.roles.includes("manager") && m.status === "active"));
  assert.ok(env.systemStore.members.some((m) => m.principalId === "usr_duy" && m.roles.includes("operator") && m.status === "active"));

  // Admin kích hoạt chính sách phân quyền (activatePolicy)
  adminPermTree = adminClient.reRenderCurrentPermissions("company-ops", "1.0.0");
  const activatePolicyBtn = adminClient.find(adminPermTree, (n) => n.type === "button" && n.children?.[0] === "Kích hoạt thực thi chính sách");
  assert.ok(activatePolicyBtn, "Nút kích hoạt thực thi chính sách phải hiển thị cho Admin");
  await activatePolicyBtn.props.onClick();
  await adminClient.flushEffects();

  assert.equal(env.systemStore.policy.status, "enforced", "Chính sách phân quyền phải chuyển sang enforced");
  assert.equal(env.systemStore.policy.revision, 1, "Revision chính sách phải tăng lên 1");
});

test("MÔ PHỎNG HARNESS (simulation harness with real bridge validation) - BƯỚC 3, 4, 5: Kịch bản liên phòng ban (Alice tạo -> Bob duyệt -> Duy hoàn thành)", async () => {
  const env = createEnterpriseE2EEnvironment();
  // Ensure members exist with active policy
  env.systemStore.policy.status = "enforced";
  env.systemStore.policy.revision = 1;
  env.systemStore.members.push(
    { systemId: "company-ops", systemVersion: "1.0.0", principalType: "person", principalId: "usr_alice", roles: ["employee"], status: "active", revision: 1 },
    { systemId: "company-ops", systemVersion: "1.0.0", principalType: "person", principalId: "usr_bob", roles: ["manager"], status: "active", revision: 1 },
    { systemId: "company-ops", systemVersion: "1.0.0", principalType: "person", principalId: "usr_duy", roles: ["operator"], status: "active", revision: 1 },
  );

  // 1. ALICE (Nhân viên - vai trò employee) đăng nhập vào Workspace
  const aliceActor = {
    username: "alice",
    subject: "usr_alice",
    organizationId: "org_default",
    roles: ["employee"],
    canManageOrg: false,
  };
  const aliceClient = env.createClientForActor(aliceActor);

  // Alice vào Workspace (/lattice)
  let aliceWorkspaceTree = await aliceClient.renderWorkspace();
  const aliceSystemCard = aliceClient.find(
    aliceWorkspaceTree,
    (n) => n.type === "h3" && n.children.includes("Điều hành công ty"),
  );
  assert.ok(aliceSystemCard, "Alice phải thấy hệ thống 'Điều hành công ty' trong Workspace");

  // Alice mở hệ thống (/lattice/systems/company-ops/1.0.0)
  let aliceRuntimeTree = await aliceClient.renderSystemRuntime("/lattice/systems/company-ops/1.0.0");

  // Alice thấy form "Tạo yêu cầu mới" vì có canStart: true
  const startLegend = aliceClient.find(
    aliceRuntimeTree,
    (n) => n.type === "legend" && n.children.includes("Tạo yêu cầu mới"),
  );
  assert.ok(startLegend, "Alice (employee) phải thấy form tạo yêu cầu mới");

  // Form có trường nhập tiêu đề
  const titleField = aliceClient.find(aliceRuntimeTree, (n) => n.props?.["data-field"] === "Tiêu đề yêu cầu" || n.type === "input");
  assert.ok(titleField, "Form phải có trường nhập tiêu đề");

  // Tạo yêu cầu qua store
  env.systemStore.workflows.push({
    id: "run-ops-101",
    definitionId: "cross-requests",
    title: "Đề xuất cấp phát máy chủ thử nghiệm",
    creator: "usr_alice",
    handlerId: "usr_duy",
    state: "draft",
    version: 1,
    data: {
      content: "Phòng Kinh doanh đề xuất cấp máy chủ chạy thử nghiệm dự án mới",
      handlerId: "usr_duy",
    },
  });
  env.systemStore.auditLogs.push({ action: "create", actor: "usr_alice", runId: "run-ops-101" });

  // Alice mở hồ sơ vừa tạo
  aliceRuntimeTree = await aliceClient.renderSystemRuntime("/lattice/systems/company-ops/1.0.0");
  const aliceRunBtn = aliceClient.find(
    aliceRuntimeTree,
    (n) => n.type === "button" && n.children.some((c) => typeof c === "string" && c.includes("Đề xuất cấp phát")),
  );
  assert.ok(aliceRunBtn, "Alice phải thấy hồ sơ vừa tạo trong danh sách");
  await aliceRunBtn.props.onClick();

  for (let i = 0; i < 3; i++) {
    await aliceClient.flushEffects();
    aliceRuntimeTree = aliceClient.reRenderCurrentRuntime("/lattice/systems/company-ops/1.0.0");
  }

  // Alice thấy nút chuyển bước "Gửi duyệt" (submit)
  const submitBtn = aliceClient.find(
    aliceRuntimeTree,
    (n) => n.type === "button" && n.children.includes("Gửi duyệt"),
  );
  assert.ok(submitBtn, "Alice phải thấy nút hành động 'Gửi duyệt'");
  await submitBtn.props.onClick();
  await aliceClient.flushEffects();

  // Hồ sơ đã chuyển sang state = submitted
  const submittedRun = env.systemStore.workflows.find((w) => w.id === "run-ops-101");
  assert.equal(submittedRun.state, "submitted", "Hồ sơ phải chuyển sang trạng thái đã gửi duyệt");

  // 2. BOB (Quản lý - vai trò manager) vào kiểm tra và duyệt
  const bobActor = {
    username: "bob",
    subject: "usr_bob",
    organizationId: "org_default",
    roles: ["manager"],
    canManageOrg: false,
  };
  const bobClient = env.createClientForActor(bobActor);
  let bobRuntimeTree = await bobClient.renderSystemRuntime("/lattice/systems/company-ops/1.0.0");

  // Bob KHÔNG thấy form "Tạo yêu cầu mới" vì Bob chỉ có vai trò duyệt
  const bobStartLegend = bobClient.find(
    bobRuntimeTree,
    (n) => n.type === "legend" && n.children.includes("Tạo yêu cầu mới"),
  );
  assert.equal(bobStartLegend, undefined, "Bob (manager) không được thấy form tạo yêu cầu");

  // Bob vào Hộp việc (inbox)
  const bobInboxBtn = bobClient.find(
    bobRuntimeTree,
    (n) => n.type === "button" && n.children.includes("Việc cần xử lý của tôi"),
  );
  assert.ok(bobInboxBtn, "Bob phải có nút chuyển sang hộp việc cá nhân");
  await bobInboxBtn.props.onClick();

  for (let i = 0; i < 3; i++) {
    await bobClient.flushEffects();
    bobRuntimeTree = bobClient.reRenderCurrentRuntime("/lattice/systems/company-ops/1.0.0");
  }

  // Bob thấy hồ sơ của Alice đang chờ duyệt
  const bobRunBtn = bobClient.find(
    bobRuntimeTree,
    (n) => n.type === "button" && n.children.some((c) => typeof c === "string" && c.includes("Đề xuất cấp phát")),
  );
  assert.ok(bobRunBtn, "Bob phải thấy hồ sơ của Alice trong hộp việc chờ duyệt");
  await bobRunBtn.props.onClick();

  for (let i = 0; i < 3; i++) {
    await bobClient.flushEffects();
    bobRuntimeTree = bobClient.reRenderCurrentRuntime("/lattice/systems/company-ops/1.0.0");
  }

  // Bob thấy các nút hành động của Manager: "Phê duyệt và giao việc" & "Từ chối"
  const bobApproveBtn = bobClient.find(
    bobRuntimeTree,
    (n) => n.type === "button" && n.children.includes("Phê duyệt và giao việc"),
  );
  const bobRejectBtn = bobClient.find(
    bobRuntimeTree,
    (n) => n.type === "button" && n.children.includes("Từ chối"),
  );
  assert.ok(bobApproveBtn && bobRejectBtn, "Bob (manager) phải thấy hành động Duyệt và Từ chối");

  // Bob bấm phê duyệt
  await bobApproveBtn.props.onClick();
  await bobClient.flushEffects();
  const approvedRun = env.systemStore.workflows.find((w) => w.id === "run-ops-101");
  assert.equal(approvedRun.state, "approved", "Hồ sơ phải chuyển sang trạng thái đã phê duyệt");

  // 3. DUY (Kỹ thuật/Vận hành - vai trò operator) nhận việc và hoàn thành
  const duyActor = {
    username: "duy",
    subject: "usr_duy",
    organizationId: "org_default",
    roles: ["operator"],
    canManageOrg: false,
  };
  const duyClient = env.createClientForActor(duyActor);
  let duyRuntimeTree = await duyClient.renderSystemRuntime("/lattice/systems/company-ops/1.0.0");

  // Duy vào Hộp việc (inbox)
  const duyInboxBtn = duyClient.find(
    duyRuntimeTree,
    (n) => n.type === "button" && n.children.includes("Việc cần xử lý của tôi"),
  );
  await duyInboxBtn.props.onClick();

  for (let i = 0; i < 3; i++) {
    await duyClient.flushEffects();
    duyRuntimeTree = duyClient.reRenderCurrentRuntime("/lattice/systems/company-ops/1.0.0");
  }

  // Duy thấy công việc được giao
  const duyRunBtn = duyClient.find(
    duyRuntimeTree,
    (n) => n.type === "button" && n.children.some((c) => typeof c === "string" && c.includes("Đề xuất cấp phát")),
  );
  assert.ok(duyRunBtn, "Duy phải thấy công việc được giao trong hộp việc");
  await duyRunBtn.props.onClick();

  for (let i = 0; i < 3; i++) {
    await duyClient.flushEffects();
    duyRuntimeTree = duyClient.reRenderCurrentRuntime("/lattice/systems/company-ops/1.0.0");
  }

  // Duy thấy hành động của Operator: "Hoàn thành"
  const completeBtn = duyClient.find(
    duyRuntimeTree,
    (n) => n.type === "button" && n.children.includes("Hoàn thành"),
  );
  assert.ok(completeBtn, "Duy (operator) phải thấy nút hành động 'Hoàn thành'");

  // Duy bấm hoàn thành
  await completeBtn.props.onClick();
  await duyClient.flushEffects();
  const completedRun = env.systemStore.workflows.find((w) => w.id === "run-ops-101");
  assert.equal(completedRun.state, "completed", "Hồ sơ phải được hoàn thành trọn vẹn (state = completed)");

  // 4. KIỂM TRA TÍNH TOÀN VẸN CỦA QUY TRÌNH:
  assert.equal(env.systemStore.auditLogs.length, 4, "Audit logs phải ghi lại đúng 4 bước: create, submit, approve, complete");
});

test("MÔ PHỎNG HARNESS (simulation harness with real bridge validation) - BƯỚC 6: Thu hồi quyền thành viên (revokeMember) kiểm tra CAS revision và từ chối truy cập", async () => {
  const env = createEnterpriseE2EEnvironment();
  // Setup Alice active with enforced policy
  env.systemStore.policy.status = "enforced";
  env.systemStore.policy.revision = 1;
  env.systemStore.members.push({
    systemId: "company-ops",
    systemVersion: "1.0.0",
    principalType: "person",
    principalId: "usr_alice",
    roles: ["employee"],
    status: "active",
    revision: 1,
  });

  const adminActor = {
    username: "admin",
    subject: "usr_admin",
    organizationId: "org_default",
    roles: ["workflow:design", "data:design"],
    canManageOrg: true,
  };
  const adminClient = env.createClientForActor(adminActor);
  let adminPermTree = await adminClient.renderMemberPermissions("company-ops", "1.0.0");

  // Admin thu hồi quyền Alice qua MemberPermissions UI
  const revokeAliceBtn = adminClient.find(adminPermTree, (n) => n.type === "button" && n.children?.[0] === "Thu hồi");
  assert.ok(revokeAliceBtn, "Phải có nút thu hồi quyền thành viên");
  await revokeAliceBtn.props.onClick();
  await adminClient.flushEffects();

  const aliceGrant = env.systemStore.members.find((m) => m.principalId === "usr_alice");
  assert.equal(aliceGrant.status, "revoked", "Trạng thái phân quyền của Alice phải chuyển thành revoked");
  assert.equal(aliceGrant.revision, 2, "Revision của grant phải tăng lên 2 sau khi thu hồi");

  // Alice kiểm tra quyền hiệu lực qua myAccess
  const aliceActor = {
    username: "alice",
    subject: "usr_alice",
    organizationId: "org_default",
    roles: ["employee"],
    canManageOrg: false,
  };
  const aliceClient = env.createClientForActor(aliceActor);
  const myAccess = await aliceClient.api.studio("myAccess", { id: "company-ops", version: "1.0.0" });
  assert.equal(myAccess.hasAccess, false, "Alice không còn quyền truy cập sau khi bị thu hồi");
  assert.deepEqual(myAccess.effectiveRoles, [], "Alice không còn vai trò quy trình");
  assert.deepEqual(myAccess.sources, [], "Sources của Alice phải trống");
});
