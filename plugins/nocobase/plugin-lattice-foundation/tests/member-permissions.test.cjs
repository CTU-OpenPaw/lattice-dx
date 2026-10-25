// SPDX-License-Identifier: Apache-2.0
const { test } = require("node:test"),
  assert = require("node:assert/strict");

const { createMemberPermissions } = require("../src/client/member-permissions");
const { createOrganizationScreen } = require("../src/client/organization-screen");

function setupTestEnvironment({ canManage = true, mockMembers = null, failGrant = false } = {}) {
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
  };

  const executedCommands = [];
  const studioCalls = [];

  const session = {
    connection: { connected: true },
    capabilities: {
      "organization.manage": { available: canManage },
    },
    busy: false,
    commands: {
      uncertain: false,
      execute: async (op, payload) => {
        executedCommands.push({ op, payload });
        if (failGrant && op === "grantSystemMember") {
          throw new Error("Không đủ quyền quản trị để cấp vai trò.");
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
        if (op === "apps") {
          return {
            items: [
              {
                id: "company-ops",
                version: "1.0.0",
                title: "Điều hành công ty",
                definitions: [
                  {
                    id: "cross-requests",
                    startRole: "employee",
                    readerRoles: ["manager"],
                    assignedReader: { role: "operator" },
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
        if (op === "app") {
          return {
            id: args.id || "company-ops",
            version: "1.0.0",
            title: "Điều hành công ty",
            definitions: [
              {
                id: "cross-requests",
                startRole: "employee",
                readerRoles: ["manager"],
                assignedReader: { role: "operator" },
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
        if (op === "systemMembers") {
          if (mockMembers !== null) return mockMembers;
          throw new Error("Endpoint not yet implemented");
        }
        return { items: [], page: { hasMore: false } };
      },
      workflow: async (op) => {
        if (op === "people") {
          return {
            items: [
              { subject: "usr_alice", displayName: "Alice Nguyen", departmentId: "dep_finance", roles: ["employee"] },
              { subject: "usr_bob", displayName: "Bob Tran", departmentId: "dep_hr", roles: ["manager"] },
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
    renderPermissions(systemId) {
      index = 0;
      return MemberPermissions({ session, systemId });
    },
    renderOrganization() {
      index = 0;
      return Organization({ session });
    },
    flushEffects,
    find,
    findAll,
    executedCommands,
    studioCalls,
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

test("MemberPermissions renders system selector, roles summary, and empty state when no members assigned", async () => {
  const env = setupTestEnvironment({ mockMembers: { items: [], page: { hasMore: false } } });
  let tree = env.renderPermissions("company-ops");
  await env.flushEffects();
  tree = env.renderPermissions("company-ops");

  // Roles summary
  const roleTags = env.findAll(tree, (n) => typeof n.children?.[0] === "string" && n.children[0].includes("Nhân viên (Khởi tạo yêu cầu)"));
  assert.ok(roleTags.length > 0, "Must display defined system roles summary");

  // Empty state message
  const emptyMsg = env.find(tree, (n) => typeof n.children?.[0] === "string" && n.children[0].includes("Chưa có tài khoản nào được chỉ định"));
  assert.ok(emptyMsg, "Must render clear empty state when no members are granted");
});

test("MemberPermissions grants a member roles and handles API execution", async () => {
  const env = setupTestEnvironment({ mockMembers: { items: [], page: { hasMore: false } } });
  let tree = env.renderPermissions("company-ops");
  await env.flushEffects();
  tree = env.renderPermissions("company-ops");

  // Select a user
  const personSelect = env.find(tree, (n) => n.type === "select" && n.children?.some((c) => c.props?.value === "usr_alice"));
  assert.ok(personSelect, "Must render person select dropdown with directory people");
  personSelect.props.onChange({ target: { value: "usr_alice" } });
  tree = env.renderPermissions("company-ops");

  // Select employee role checkbox
  const checkboxes = env.findAll(tree, (n) => n.type === "input" && n.props?.type === "checkbox");
  assert.ok(checkboxes.length >= 3, "Must have checkboxes for each system role");
  // Check the first role (employee)
  checkboxes[0].props.onChange({ target: { checked: true } });
  tree = env.renderPermissions("company-ops");

  // Submit grant button
  const grantBtn = env.find(tree, (n) => n.type === "button" && n.children?.[0] === "Cấp quyền cho nhân viên");
  assert.ok(grantBtn, "Must render grant button");
  assert.equal(grantBtn.props.disabled, false, "Button should be enabled once user and role are selected");

  await grantBtn.props.onClick();
  await env.flushEffects();

  assert.equal(env.executedCommands.length, 1);
  assert.equal(env.executedCommands[0].op, "grantSystemMember");
  assert.equal(env.executedCommands[0].payload.id, "company-ops");
  assert.equal(env.executedCommands[0].payload.body.subject, "usr_alice");
  assert.deepEqual(env.executedCommands[0].payload.body.roles, ["employee"]);
});

test("MemberPermissions renders member table with roles and handles revoke action", async () => {
  const mockMembers = {
    items: [
      {
        subject: "usr_alice",
        displayName: "Alice Nguyen",
        departmentName: "Phòng Tài chính",
        roles: ["employee", "manager"],
      },
    ],
    page: { hasMore: false },
  };

  const env = setupTestEnvironment({ mockMembers });
  let tree = env.renderPermissions("company-ops");
  await env.flushEffects();
  tree = env.renderPermissions("company-ops");

  // Find member in table
  const aliceRow = env.find(tree, (n) => n.children?.[0] === "Alice Nguyen");
  assert.ok(aliceRow, "Must render member Alice Nguyen in table");

  // Find revoke button
  const revokeBtn = env.find(tree, (n) => n.type === "button" && n.children?.[0] === "Thu hồi");
  assert.ok(revokeBtn, "Must render revoke button for member");

  await revokeBtn.props.onClick();
  await env.flushEffects();

  assert.equal(env.executedCommands.length, 1);
  assert.equal(env.executedCommands[0].op, "revokeSystemMember");
  assert.equal(env.executedCommands[0].payload.id, "company-ops");
  assert.equal(env.executedCommands[0].payload.body.subject, "usr_alice");
});

test("MemberPermissions reports server error when permission grant fails", async () => {
  const env = setupTestEnvironment({
    mockMembers: { items: [], page: { hasMore: false } },
    failGrant: true,
  });
  let tree = env.renderPermissions("company-ops");
  await env.flushEffects();
  tree = env.renderPermissions("company-ops");

  // Select user and role
  const personSelect = env.find(tree, (n) => n.type === "select" && n.children?.some((c) => c.props?.value === "usr_bob"));
  assert.ok(personSelect, "Person select dropdown should exist");
  personSelect.props.onChange({ target: { value: "usr_bob" } });
  tree = env.renderPermissions("company-ops");

  const checkboxes = env.findAll(tree, (n) => n.type === "input" && n.props?.type === "checkbox");
  checkboxes[0].props.onChange({ target: { checked: true } });
  tree = env.renderPermissions("company-ops");

  const grantBtn = env.find(tree, (n) => n.type === "button" && n.children?.[0] === "Cấp quyền cho nhân viên");
  await grantBtn.props.onClick();
  await env.flushEffects();
  tree = env.renderPermissions("company-ops");

  const errAlert = env.find(tree, (n) => n.props?.role === "alert" && typeof n.children?.[0] === "string" && n.children[0].includes("Không đủ quyền"));
  assert.ok(errAlert, "Must display server error banner when grant fails");
});
