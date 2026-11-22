/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const { test } = require("node:test"),
  assert = require("node:assert/strict");

const { createMemberPermissions } = require("../src/client/member-permissions");
const { createOrganizationScreen } = require("../src/client/organization-screen");
const { studioRequest, BridgeError } = require("../../action-bridge/studio.cjs");
const queryValidator = (q) => (q ? new URLSearchParams(Object.entries(q)).toString() : "");

function setupTestEnvironment({
  canManage = true,
  mockMembers = null,
  failGrant = false,
  failPolicy = false,
  policyStatus = "legacy",
  customSystems = null,
  onStudioCall = null,
} = {}) {
  const slots = [],
    effects = [],
    pending = [];
  let index = 0;

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
      if (!slots[i] || deps?.some((v, k) => v !== slots[i].deps[k])) {
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
  };

  const executedCommands = [];
  const studioCalls = [];

  const session = {
    connection: {
      connected: true,
      identity: {
        subject: "usr_admin",
        organizationId: "org_default",
        roles: canManage ? ["workflow:design", "data:design"] : ["employee"],
      },
    },
    capabilities: {
      "workflow.design": { available: canManage },
      "data.design": { available: canManage },
    },
    busy: false,
    commands: {
      uncertain: false,
      execute: async (op, payload) => {
        executedCommands.push({ op, payload });
        // Validate with real bridge contract!
        studioRequest({ operation: op, ...payload, key: "test-key" }, BridgeError, queryValidator);

        if (failGrant && op === "grantMember") {
          const err = new Error("Không đủ quyền quản trị để cấp vai trò.");
          err.status = 403;
          throw err;
        }
        if (failPolicy && op === "activatePolicy") {
          const err = new Error("Xung đột revision chính sách.");
          err.status = 409;
          throw err;
        }
        return { success: true };
      },
    },
    report: () => {},
    act: (fn) => {
      const promise = Promise.resolve().then(fn);
      pending.push(promise);
      return promise;
    },
    api: {
      studio: async (op, args = {}) => {
        studioCalls.push({ op, args });
        // Real bridge request validation
        studioRequest({ operation: op, ...args }, BridgeError, queryValidator);

        if (typeof onStudioCall === "function") {
          const custom = await onStudioCall(op, args);
          if (custom !== undefined) return custom;
        }

        if (op === "apps" || op === "adminSystems") {
          return {
            items: customSystems || [
              {
                id: "company-ops",
                version: "1.0.0",
                title: "Điều hành công ty",
                permittedBusinessRoles: ["employee", "manager", "operator"],
                definitions: [
                  {
                    id: "cross-requests",
                    startRole: "employee",
                    readerRoles: ["manager"],
                    assignedReader: { role: "operator" },
                    published: true,
                    transitions: [
                      { role: "employee" },
                      { role: "manager" },
                      { role: "operator" },
                    ],
                  },
                ],
              },
            ],
            page: { hasMore: false },
          };
        }
        if (op === "app" || op === "adminSystem") {
          assert.ok(args.id, "app/adminSystem query requires id");
          assert.ok(args.version, "app/adminSystem query requires immutable version");
          if (customSystems) {
            const found = customSystems.find((s) => s.id === args.id && s.version === args.version);
            if (found) return found;
          }
          return {
            id: args.id,
            version: args.version,
            title: "Điều hành công ty",
            permittedBusinessRoles: ["employee", "manager", "operator"],
            definitions: [
              {
                id: "cross-requests",
                startRole: "employee",
                readerRoles: ["manager"],
                assignedReader: { role: "operator" },
                published: true,
                transitions: [{ role: "employee" }, { role: "manager" }, { role: "operator" }],
              },
            ],
          };
        }
        if (op === "departments") {
          return {
            items: [
              { id: "dep_finance", name: "Phòng Tài chính" },
              { id: "dep_hr", name: "Phòng Nhân sự" },
            ],
            page: { hasMore: false },
          };
        }
        if (op === "members") {
          assert.ok(args.id, "members query requires id");
          assert.ok(args.version, "members query requires version");
          return mockMembers || { items: [], page: { hasMore: false } };
        }
        if (op === "policy") {
          assert.ok(args.id, "policy query requires id");
          assert.ok(args.version, "policy query requires version");
          return {
            systemId: args.id,
            version: args.version,
            status: policyStatus,
            revision: 0,
          };
        }
        if (op === "myAccess") {
          assert.ok(args.id, "myAccess query requires id");
          assert.ok(args.version, "myAccess query requires version");
          return {
            systemId: args.id,
            version: args.version,
            hasAccess: true,
            effectiveRoles: ["employee"],
            sources: [
              { source: "person", principalId: "usr_alice", roles: ["employee"] },
            ],
            enforcementStatus: policyStatus,
          };
        }
        return { items: [] };
      },
      workflow: async (op) => {
        if (op === "people") {
          return {
            items: [
              {
                subject: "usr_alice",
                displayName: "Alice Nguyen",
                departmentId: "dep_finance",
              },
              {
                subject: "usr_bob",
                displayName: "Bob Tran",
                departmentId: "dep_hr",
              },
            ],
            page: { hasMore: false },
          };
        }
        return { items: [] };
      },
    },
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
  const Organization = createOrganizationScreen(React, shell);

  function find(tree, predicate) {
    if (!tree || typeof tree !== "object") return undefined;
    if (predicate(tree)) return tree;
    if (typeof tree.type === "function") {
      const rendered = tree.type(tree.props);
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
    while (pending.length) {
      await Promise.all(pending.splice(0));
    }
  }

  return {
    renderPermissions(systemId = "company-ops", systemVersion = "1.0.0") {
      index = 0;
      return MemberPermissions({ session, systemId, systemVersion });
    },
    renderOrganization() {
      index = 0;
      return Organization({ session });
    },
    flushEffects,
    triggerEffects() {
      for (const eff of effects.splice(0)) {
        eff();
      }
    },
    effects,
    pending,
    find,
    findAll,
    executedCommands,
    studioCalls,
    session,
  };
}

test("Organization screen renders navigation tabs and switches between structure and permissions", async () => {
  const env = setupTestEnvironment();
  let tree = env.renderOrganization();
  await env.flushEffects();
  tree = env.renderOrganization();

  // Navigation buttons
  const structBtn = env.find(tree, (n) => n.type === "button" && n.children?.[0] === "Cơ cấu phòng ban & Danh bạ");
  const permBtn = env.find(tree, (n) => n.type === "button" && n.children?.[0] === "Phân quyền theo hệ thống");

  assert.ok(structBtn, "Must render Structure tab button");
  assert.ok(permBtn, "Must render Permissions tab button");

  // Default renders structure
  const deptTitle = env.find(tree, (n) => n.type === "h3" && n.children?.[0] === "Cơ cấu phòng ban");
  assert.ok(deptTitle, "Should render Department structure by default");

  // Switch to permissions
  permBtn.props.onClick();
  tree = env.renderOrganization();
  await env.flushEffects();
  tree = env.renderOrganization();

  const permComp = env.find(tree, (n) => typeof n.type === "function" && n.type.name === "MemberPermissions");
  assert.ok(permComp, "Should switch and mount MemberPermissions component");
});

test("MemberPermissions renders system selector, roles summary, policy status and empty state", async () => {
  const env = setupTestEnvironment({ mockMembers: { items: [], page: { hasMore: false } } });
  let tree = env.renderPermissions("company-ops", "1.0.0");
  await env.flushEffects();
  tree = env.renderPermissions("company-ops", "1.0.0");

  // Roles summary
  const roleTags = env.findAll(tree, (n) => typeof n.children?.[0] === "string" && n.children[0].includes("Nhân viên (Khởi tạo yêu cầu)"));
  assert.ok(roleTags.length > 0, "Must display defined system roles summary");

  // Policy status check
  const policyStatusMsg = env.find(tree, (n) => typeof n.children?.[0] === "string" && n.children[0].includes("Chính sách thực thi phân quyền"));
  assert.ok(policyStatusMsg, "Must render explicit policy status");

  // Effective access check (myAccess)
  const myAccessMsg = env.find(tree, (n) => typeof n.children?.[0] === "string" && n.children[0].includes("Quyền hiệu lực của bạn (myAccess)"));
  assert.ok(myAccessMsg, "Must render myAccess effective roles and sources");

  // Empty state message
  const emptyMsg = env.find(tree, (n) => typeof n.children?.[0] === "string" && n.children[0].includes("Chưa có tài khoản hoặc phòng ban nào"));
  assert.ok(emptyMsg, "Must render clear empty state when no members are granted");
});

test("MemberPermissions grants a member roles using exact bridge contract (grantMember)", async () => {
  const env = setupTestEnvironment({ mockMembers: { items: [], page: { hasMore: false } } });
  let tree = env.renderPermissions("company-ops", "1.0.0");
  await env.flushEffects();
  tree = env.renderPermissions("company-ops", "1.0.0");

  // Select a user
  const personSelect = env.find(tree, (n) => n.type === "select" && n.children?.some((c) => c.props?.value === "usr_alice"));
  assert.ok(personSelect, "Must render person select dropdown with directory people");
  personSelect.props.onChange({ target: { value: "usr_alice" } });
  tree = env.renderPermissions("company-ops", "1.0.0");

  // Select employee role checkbox
  const checkboxes = env.findAll(tree, (n) => n.type === "input" && n.props?.type === "checkbox");
  assert.ok(checkboxes.length >= 3, "Must have checkboxes for each system role");
  // Check the first role (employee)
  checkboxes[0].props.onChange({ target: { checked: true } });
  tree = env.renderPermissions("company-ops", "1.0.0");

  // Submit grant button
  const grantBtn = env.find(tree, (n) => n.type === "button" && n.children?.[0] === "Cấp quyền truy cập");
  assert.ok(grantBtn, "Must render grant button");
  assert.equal(grantBtn.props.disabled, false, "Button should be enabled once user is selected");

  await grantBtn.props.onClick();
  await env.flushEffects();

  assert.equal(env.executedCommands.length, 1);
  assert.equal(env.executedCommands[0].op, "grantMember");
  assert.equal(env.executedCommands[0].payload.id, "company-ops");
  assert.equal(env.executedCommands[0].payload.version, "1.0.0");
  assert.deepEqual(env.executedCommands[0].payload.body, {
    principalType: "person",
    principalId: "usr_alice",
    roles: ["employee"],
  });
});

test("MemberPermissions activates policy explicitly with CAS revision (activatePolicy)", async () => {
  const env = setupTestEnvironment({
    mockMembers: { items: [], page: { hasMore: false } },
    policyStatus: "legacy",
  });
  let tree = env.renderPermissions("company-ops", "1.0.0");
  await env.flushEffects();
  tree = env.renderPermissions("company-ops", "1.0.0");

  const activateBtn = env.find(tree, (n) => n.type === "button" && n.children?.[0] === "Kích hoạt thực thi chính sách");
  assert.ok(activateBtn, "Must render explicit activate policy button for admin");

  await activateBtn.props.onClick();
  await env.flushEffects();

  assert.equal(env.executedCommands.length, 1);
  assert.equal(env.executedCommands[0].op, "activatePolicy");
  assert.equal(env.executedCommands[0].payload.id, "company-ops");
  assert.equal(env.executedCommands[0].payload.version, "1.0.0");
  assert.deepEqual(env.executedCommands[0].payload.body, {
    expectedRevision: 0,
  });
});

test("MemberPermissions renders member table, updates roles with CAS revision, and revokes", async () => {
  const mockMembers = {
    items: [
      {
        principalType: "person",
        principalId: "usr_alice",
        roles: ["employee"],
        revision: 1,
        status: "active",
      },
    ],
    page: { hasMore: false },
  };

  const env = setupTestEnvironment({ mockMembers });
  let tree = env.renderPermissions("company-ops", "1.0.0");
  await env.flushEffects();
  tree = env.renderPermissions("company-ops", "1.0.0");

  // Find member in table
  const aliceRow = env.find(tree, (n) => n.children?.[0] === "Alice Nguyen");
  assert.ok(aliceRow, "Must render member Alice Nguyen in table");

  // Find edit role button
  const editBtn = env.find(tree, (n) => n.type === "button" && n.children?.[0] === "Sửa vai trò");
  assert.ok(editBtn, "Must render edit button for active member");
  editBtn.props.onClick();
  tree = env.renderPermissions("company-ops", "1.0.0");

  // In edit mode: save update
  const saveBtn = env.find(tree, (n) => n.type === "button" && n.children?.[0] === "Lưu thay đổi vai trò");
  assert.ok(saveBtn, "Must render save update button in edit mode");
  await saveBtn.props.onClick();
  await env.flushEffects();

  assert.equal(env.executedCommands.length, 1);
  assert.equal(env.executedCommands[0].op, "updateMember");
  assert.equal(env.executedCommands[0].payload.id, "company-ops");
  assert.equal(env.executedCommands[0].payload.version, "1.0.0");
  assert.equal(env.executedCommands[0].payload.principalType, "person");
  assert.equal(env.executedCommands[0].payload.principalId, "usr_alice");
  assert.deepEqual(env.executedCommands[0].payload.body, {
    expectedRevision: 1,
    roles: ["employee"],
  });

  // Revoke button
  const revokeBtn = env.find(tree, (n) => n.type === "button" && n.children?.[0] === "Thu hồi");
  assert.ok(revokeBtn, "Must render revoke button for member");
  await revokeBtn.props.onClick();
  await env.flushEffects();

  assert.equal(env.executedCommands.length, 2);
  assert.equal(env.executedCommands[1].op, "revokeMember");
  assert.equal(env.executedCommands[1].payload.id, "company-ops");
  assert.equal(env.executedCommands[1].payload.version, "1.0.0");
  assert.equal(env.executedCommands[1].payload.principalType, "person");
  assert.equal(env.executedCommands[1].payload.principalId, "usr_alice");
  assert.deepEqual(env.executedCommands[1].payload.body, {
    expectedRevision: 1,
  });
});

test("MemberPermissions reports server error when permission grant fails with 403", async () => {
  const env = setupTestEnvironment({
    mockMembers: { items: [], page: { hasMore: false } },
    failGrant: true,
  });
  let tree = env.renderPermissions("company-ops", "1.0.0");
  await env.flushEffects();
  tree = env.renderPermissions("company-ops", "1.0.0");

  const personSelect = env.find(tree, (n) => n.type === "select" && n.children?.some((c) => c.props?.value === "usr_bob"));
  assert.ok(personSelect, "Person select dropdown should exist");
  personSelect.props.onChange({ target: { value: "usr_bob" } });
  tree = env.renderPermissions("company-ops", "1.0.0");

  const grantBtn = env.find(tree, (n) => n.type === "button" && n.children?.[0] === "Cấp quyền truy cập");
  await grantBtn.props.onClick();
  await env.flushEffects();
  tree = env.renderPermissions("company-ops", "1.0.0");

  const errAlert = env.find(
    tree,
    (n) =>
      n.props?.role === "alert" &&
      typeof n.children?.[0] === "string" &&
      (n.children[0].includes("không có quyền") || n.children[0].includes("Cấp quyền thất bại")),
  );
  assert.ok(errAlert, "Must display server error banner when grant fails");
});

test("MemberPermissions discards stale responses when systemId or version switches in-flight", async () => {
  let resolveCompanyOps;
  const companyOpsPromise = new Promise((r) => {
    resolveCompanyOps = r;
  });

  const customSystems = [
    {
      id: "company-ops",
      version: "1.0.0",
      title: "Điều hành công ty",
      permittedBusinessRoles: ["employee"],
      definitions: [{ id: "def-ops", published: true, startRole: "employee" }],
    },
    {
      id: "procurement-ops",
      version: "2.0.0",
      title: "Quản lý mua sắm",
      permittedBusinessRoles: ["buyer"],
      definitions: [{ id: "def-proc", published: true, startRole: "buyer" }],
    },
  ];

  let delay = false;
  const env = setupTestEnvironment({
    customSystems,
    onStudioCall: async (op, args) => {
      if ((op === "adminSystem" || op === "app") && args.id === "company-ops" && delay) {
        await companyOpsPromise;
        return {
          ...customSystems[0],
          title: "STALE COMPANY OPS DATA",
        };
      }
      return undefined;
    },
  });

  // Step 1: Initial render loads systems
  let tree = env.renderPermissions("company-ops", "1.0.0");
  await env.flushEffects();
  tree = env.renderPermissions("company-ops", "1.0.0");

  // Step 2: Now enable delay for any upcoming company-ops query
  delay = true;

  // Step 3: User changes selection to procurement-ops:2.0.0
  const systemSelect = env.find(tree, (n) => n.type === "select" && n.children?.some((c) => c.props?.value === "procurement-ops:2.0.0"));
  assert.ok(systemSelect, "System select dropdown should have procurement-ops option");
  systemSelect.props.onChange({ target: { value: "procurement-ops:2.0.0" } });

  // Resolve delayed company-ops in next microtask
  setImmediate(() => {
    resolveCompanyOps();
  });

  // Flush all pending effects
  await env.flushEffects();
  tree = env.renderPermissions("company-ops", "1.0.0");

  // Visible view must display procurement-ops
  const titleDisplay = env.find(tree, (n) => typeof n.children?.[0] === "string" && n.children[0].includes("Quản lý mua sắm"));
  assert.ok(titleDisplay, "Visible view must display procurement-ops");

  // Stale company-ops title must NOT overwrite procurement-ops
  const staleDisplay = env.find(tree, (n) => typeof n.children?.[0] === "string" && n.children[0].includes("STALE COMPANY OPS DATA"));
  assert.equal(staleDisplay, undefined, "Stale company-ops response must be discarded and not overwrite current system view");
});

test("MemberPermissions derives permittedBusinessRoles strictly and shows unpublished definitions warning", async () => {
  const customSystems = [
    {
      id: "warehouse-ops",
      version: "1.0.0",
      title: "Quản lý kho",
      permittedBusinessRoles: ["warehouse:keeper", "warehouse:auditor"],
      definitions: [
        { id: "wf-published", published: true, startRole: "warehouse:keeper" },
        { id: "wf-draft", published: false, startRole: "platform:operate" },
      ],
    },
  ];

  const env = setupTestEnvironment({ customSystems });
  let tree = env.renderPermissions("warehouse-ops", "1.0.0");
  await env.flushEffects();
  tree = env.renderPermissions("warehouse-ops", "1.0.0");

  // Check roles: must contain warehouse:keeper, warehouse:auditor, but NOT platform:operate or admin
  const roleBadges = env.findAll(tree, (n) => n.type === "span" && typeof n.children?.[0] === "string");
  const badgeTexts = roleBadges.map((b) => b.children[0]);
  assert.ok(badgeTexts.includes("warehouse:keeper"));
  assert.ok(badgeTexts.includes("warehouse:auditor"));
  assert.ok(!badgeTexts.includes("platform:operate"), "Platform roles must never be in system roles");

  // Check unpublished warning banner
  const warningBanner = env.find(
    tree,
    (n) => typeof n.children?.[0] === "string" && n.children[0].includes("chưa xuất bản (unpublished)"),
  );
  assert.ok(warningBanner, "Must display warning banner when system has unpublished workflow definitions");
});

test("MemberPermissions gates visible data on same-mounted identity switch and ignores late directory responses", async () => {
  let resolveLatePeople;
  const latePeoplePromise = new Promise((r) => {
    resolveLatePeople = r;
  });
  let shouldDelayPeople = true;

  const env = setupTestEnvironment({
    onStudioCall: async (op) => {
      if (op === "adminSystems" || op === "apps") {
        if (env.session.connection.identity.organizationId === "org_other") {
          return {
            items: [
              {
                id: "other-system",
                version: "1.0.0",
                title: "Hệ thống đơn vị khác",
                permittedBusinessRoles: ["operator"],
                definitions: [{ id: "def-other", published: true, startRole: "operator" }],
              },
            ],
            page: { hasMore: false },
          };
        }
      }
      return undefined;
    },
  });

  const originalWorkflow = env.session.api.workflow;
  env.session.api.workflow = async (op, args) => {
    if (op === "people" && shouldDelayPeople && env.session.connection.identity.organizationId === "org_default") {
      await latePeoplePromise;
      return {
        items: [
          { subject: "stale_person_org1", displayName: "Stale Alice Org 1", departmentId: "dep_1" },
        ],
        page: { hasMore: false },
      };
    }
    if (op === "people" && env.session.connection.identity.organizationId === "org_other") {
      return {
        items: [
          { subject: "fresh_person_org2", displayName: "Fresh Bob Org 2", departmentId: "dep_2" },
        ],
        page: { hasMore: false },
      };
    }
    return originalWorkflow(op, args);
  };

  let tree = env.renderPermissions("company-ops", "1.0.0");
  // Trigger effects without waiting for the delayed org_default people call
  env.triggerEffects();
  await Promise.resolve();
  tree = env.renderPermissions("company-ops", "1.0.0");

  // Switch identity on same mounted screen
  env.session.connection.identity = {
    subject: "usr_admin2",
    organizationId: "org_other",
    roles: ["workflow:design", "data:design"],
  };

  // Immediate render on identity switch: visible data must gate out old scope data
  tree = env.renderPermissions();
  const leakedPerson = env.find(tree, (n) => n.type === "option" && n.props?.value === "stale_person_org1");
  assert.equal(leakedPerson, undefined, "On identity switch render, old org people must not be rendered");

  // Load new org directory and let delayed old org response resolve
  resolveLatePeople();
  await env.flushEffects();
  tree = env.renderPermissions();

  const stalePersonCheck = env.find(tree, (n) => n.type === "option" && n.props?.value === "stale_person_org1");
  assert.equal(stalePersonCheck, undefined, "Late directory response from previous org must be discarded");

  const freshPerson = env.find(tree, (n) => n.type === "option" && n.props?.value === "fresh_person_org2");
  assert.ok(freshPerson, "Fresh org directory people should be rendered");
});

test("MemberPermissions locks selection during pending mutation and uncertain writes with honest retry", async () => {
  let resolveMutation;
  const mutationPromise = new Promise((r) => {
    resolveMutation = r;
  });

  const customSystems = [
    {
      id: "company-ops",
      version: "1.0.0",
      title: "Điều hành công ty",
      permittedBusinessRoles: ["employee"],
      definitions: [{ id: "cross-requests", published: true, startRole: "employee" }],
    },
    {
      id: "other-ops",
      version: "1.0.0",
      title: "Hệ thống khác",
      permittedBusinessRoles: ["operator"],
      definitions: [{ id: "other-flow", published: true, startRole: "operator" }],
    },
  ];

  const env = setupTestEnvironment({
    customSystems,
  });

  const originalExecute = env.session.commands.execute;
  let executionCount = 0;
  env.session.commands.execute = async (op, payload) => {
    executionCount++;
    if (op === "grantMember" && executionCount === 1) {
      await mutationPromise;
    }
    return originalExecute(op, payload);
  };

  let tree = env.renderPermissions("company-ops", "1.0.0");
  await env.flushEffects();
  tree = env.renderPermissions("company-ops", "1.0.0");

  const personSelect = env.find(tree, (n) => n.type === "select" && n.children?.some((c) => c.props?.value === "usr_alice"));
  personSelect.props.onChange({ target: { value: "usr_alice" } });
  tree = env.renderPermissions("company-ops", "1.0.0");

  const grantBtn = env.find(tree, (n) => n.type === "button" && n.children?.[0] === "Cấp quyền truy cập");
  assert.ok(grantBtn, "Grant button must exist");

  // Trigger grant mutation without awaiting completion
  const grantPromise = grantBtn.props.onClick();
  await Promise.resolve(); // Allow handleGrant to start and set pendingMutation

  tree = env.renderPermissions("company-ops", "1.0.0");

  const systemSelect = env.find(tree, (n) => n.type === "select" && n.children?.some((c) => c.props?.value === "company-ops:1.0.0"));
  assert.ok(systemSelect, "System selector dropdown must exist");
  assert.equal(systemSelect.props.disabled, true, "Selection must be locked while mutation is pending");

  // Selection change while locked must be ignored
  systemSelect.props.onChange({ target: { value: "other-ops:1.0.0" } });
  tree = env.renderPermissions("company-ops", "1.0.0");
  assert.equal(env.find(tree, (n) => n.type === "select" && n.props?.value === "other-ops:1.0.0"), undefined, "Selection switch must be ignored while blocked");

  // Simulate command becoming uncertain
  env.session.commands.uncertain = true;
  resolveMutation();
  await grantPromise;
  await env.flushEffects();
  tree = env.renderPermissions("company-ops", "1.0.0");

  const uncertainBanner = env.find(tree, (n) => typeof n.children?.[0] === "string" && n.children[0].includes("chưa xác định kết quả"));
  assert.ok(uncertainBanner, "Uncertain write banner must be displayed");

  const retryBtn = env.find(tree, (n) => n.type === "button" && n.children?.[0] === "Thử lại lệnh cho mục tiêu ban đầu");
  assert.ok(retryBtn, "Honest original-target retry button must be available");

  // Retry command
  env.session.commands.uncertain = false;
  await retryBtn.props.onClick();
  await env.flushEffects();
  tree = env.renderPermissions("company-ops", "1.0.0");

  assert.ok(env.executedCommands.length >= 2);
  assert.equal(env.executedCommands[0].payload.id, "company-ops");
  assert.equal(env.executedCommands[1].payload.id, "company-ops");
});
