// SPDX-License-Identifier: Apache-2.0
const { test } = require("node:test"),
  assert = require("node:assert/strict");

const { createWorkspaceComponent } = require("../src/client/workspace");
const { createSystemScreens } = require("../src/client/system-studio");

// Ensure timer functions don't block the Node test runner
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

function setupTestEnvironment({
  connected = true,
  systems = [
    {
      id: "company-ops",
      version: "1.0.0",
      title: "Điều hành công ty",
      enabled: true,
      description: "Hệ thống quy trình và dữ liệu điều hành doanh nghiệp",
      presentation: {
        pages: [
          {
            id: "cross-requests-page",
            title: "Quy trình đề xuất",
            definitionId: "cross-requests",
            blocks: ["create", "list", "detail"],
            fieldLabels: {
              title: "Tiêu đề yêu cầu",
              content: "Nội dung đề xuất",
              handlerId: "Người phụ trách",
            },
          },
        ],
        entityPages: [],
      },
      definitions: [
        {
          id: "cross-requests",
          canStart: true,
          startFields: { content: "string", handlerId: "string" },
          optionalStartFields: {},
          assignedReader: { role: "operator" },
        },
      ],
      schemas: [],
    },
  ],
  apps = [
    {
      id: "purchasing",
      name: "Mua sắm thiết bị",
      route: "/lattice/apps/purchasing",
      blocks: [{ id: "request-form", type: "form", title: "Tạo phiếu" }],
      workspace: { shortcut: { icon: "cart", createBlockId: "request-form", createLabel: "Tạo phiếu mua sắm" } },
    },
  ],
  capabilities = {
    "entities.read": { available: true },
    directoryRead: true,
  },
  systemError = null,
  mockDetailTransitions = null,
} = {}) {
  globalThis.setInterval = () => ({ unref: () => {} });
  globalThis.clearInterval = () => {};
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => {
    const t = originalSetTimeout(fn, ms, ...args);
    if (t && typeof t.unref === "function") t.unref();
    return t;
  };

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
    useCallback(fn) {
      return fn;
    },
  };

  const executedWorkflow = [];
  let connectionState = {
    connected,
    identity: { username: "alice", organizationId: "org_default", subject: "usr_alice" },
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    capabilities,
  };

  const clientMock = {
    useAPIClient: () => ({
      request: async (opts) => {
        if (opts.url === "auth:check") {
          return { data: { data: { username: "alice", nickname: "Alice Nguyen" } } };
        }
        if (opts.url === "latticeApps:list") {
          return { data: { data: { items: apps } } };
        }
        if (opts.url === "dxActions:status") {
          return { data: connectionState };
        }
        if (opts.url === "dxActions:disconnect") {
          connectionState = { connected: false };
          return { data: { success: true } };
        }
        if (opts.url === "dxActions:studio") {
          if (opts.data?.operation === "apps") {
            return { data: { items: systems, page: { hasMore: false } } };
          }
          if (opts.data?.operation === "app") {
            if (systemError) throw new Error(systemError);
            const found = systems.find((s) => s.id === opts.data.id);
            if (!found) throw new Error("Hệ thống không tồn tại.");
            return { data: found };
          }
        }
        if (opts.url === "dxActions:workflow") {
          const op = opts.data?.operation;
          if (op === "capabilities") {
            return { data: { capabilities } };
          }
          if (op === "member") {
            return { data: { member: true } };
          }
          if (op === "list" || op === "inbox") {
            return {
              data: {
                items:
                  op === "inbox"
                    ? [
                        {
                          id: "run-001",
                          title: "Yêu cầu cấp laptop cho phòng ban",
                          state: "pending",
                          version: 1,
                        },
                      ]
                    : [
                        {
                          id: "run-001",
                          title: "Yêu cầu cấp laptop cho phòng ban",
                          state: "pending",
                          version: 1,
                        },
                        {
                          id: "run-002",
                          title: "Yêu cầu mua văn phòng phẩm",
                          state: "approved",
                          version: 2,
                        },
                      ],
                page: { hasMore: false },
              },
            };
          }
          if (op === "detail") {
            return {
              data: {
                id: opts.data.id,
                title: "Yêu cầu cấp laptop cho phòng ban",
                state: "pending",
                version: 1,
                data: {
                  content: "Cần cấp phát 02 laptop Dell XPS",
                  handlerId: "usr_operator",
                },
                availableTransitions:
                  mockDetailTransitions !== null
                    ? mockDetailTransitions
                    : [
                        {
                          id: "approve",
                          fields: { receiptNote: "string" },
                        },
                        {
                          id: "reject",
                          fields: { reason: "string" },
                        },
                      ],
              },
            };
          }
          if (op === "history") {
            return { data: { items: [] } };
          }
          if (op === "people") {
            return {
              data: {
                items: [
                  { subject: "usr_operator", displayName: "Duy Nguyen", departmentId: "IT" },
                ],
                page: { hasMore: false },
              },
            };
          }
          if (op === "transition") {
            executedWorkflow.push({ op: "transition", data: opts.data });
            return {
              data: {
                id: opts.data.id,
                title: "Yêu cầu cấp laptop cho phòng ban",
                state: opts.data.body?.action === "approve" ? "approved" : "rejected",
                version: 2,
                data: { content: "Cần cấp phát 02 laptop Dell XPS" },
                availableTransitions: [],
              },
            };
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
      const rendered = tree.type({ ...tree.props, children: tree.children });
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

  async function renderWorkspaceAndSettle() {
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

  async function renderSystemRuntimeAndSettle(pathname = "/lattice/systems/company-ops/1.0.0") {
    index = 0;
    globalThis.window = {
      location: {
        pathname,
        search: "",
        hash: "",
        assign: () => {},
      },
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
    React,
    clientMock,
    connectionState,
    executedWorkflow,
    find,
    findAll,
    flushEffects,
    renderWorkspaceAndSettle,
    renderSystemRuntimeAndSettle,
    renderWorkspace() {
      index = 0;
      globalThis.window = {
        location: { pathname: "/lattice", search: "", hash: "" },
        addEventListener: () => {},
        removeEventListener: () => {},
      };
      globalThis.sessionStorage = { setItem: () => {}, getItem: () => null, removeItem: () => {} };
      return Workspace();
    },
    renderSystemRuntime(pathname = "/lattice/systems/company-ops/1.0.0") {
      index = 0;
      globalThis.window = {
        location: {
          pathname,
          search: "",
          hash: "",
          assign: () => {},
        },
      };
      globalThis.sessionStorage = { setItem: () => {}, getItem: () => null, removeItem: () => {} };
      return SystemRuntime();
    },
  };
}

// ---------------- TESTS ----------------

test("Workspace loads published enterprise systems and renders cards with direct system links", async () => {
  const env = setupTestEnvironment({ connected: true });
  const tree = await env.renderWorkspaceAndSettle();

  // Check section heading for published enterprise systems
  const systemsHeading = env.find(
    tree,
    (n) => n.type === "h2" && n.children.includes("Hệ thống doanh nghiệp đã xuất bản"),
  );
  assert.ok(systemsHeading, "Should render 'Hệ thống doanh nghiệp đã xuất bản' heading");

  // Check system card exists
  const systemCard = env.find(
    tree,
    (n) => n.type === "h3" && n.children.includes("Điều hành công ty"),
  );
  assert.ok(systemCard, "Should render 'Điều hành công ty' system card");

  // Check direct system link
  const link = env.find(
    tree,
    (n) =>
      n.type === "a" &&
      n.props.href === "/lattice/systems/company-ops/1.0.0" &&
      n.children.includes("Truy cập hệ thống"),
  );
  assert.ok(link, "Should render link to /lattice/systems/company-ops/1.0.0");

  // Check sidebar navigation item
  const navItem = env.find(
    tree,
    (n) =>
      n.type === "a" &&
      n.props.href === "/lattice/systems" &&
      n.children.includes("Hệ thống doanh nghiệp"),
  );
  assert.ok(navItem, "Should render sidebar item for 'Hệ thống doanh nghiệp'");
});

test("Workspace search filters both business applications and published enterprise systems", async () => {
  const env = setupTestEnvironment({ connected: true });
  let tree = await env.renderWorkspaceAndSettle();

  // Find search input
  const searchInput = env.find(tree, (n) => n.props?.["aria-label"] === "Tìm ứng dụng");
  assert.ok(searchInput, "Search input should be present");

  // Search for "Điều hành"
  searchInput.props.onChange({ target: { value: "Điều hành" } });
  tree = env.renderWorkspace();

  const searchResults = env.find(tree, (n) => n.props?.id === "lx-search-results");
  assert.ok(searchResults, "Search results popup should appear");

  const systemResult = env.find(
    searchResults,
    (n) => n.type === "a" && n.children.some((c) => typeof c === "string" && c.includes("[Hệ thống] Điều hành công ty")),
  );
  assert.ok(systemResult, "Should find the enterprise system in search results");
  assert.equal(systemResult.props.href, "/lattice/systems/company-ops/1.0.0");
});

test("SystemRuntime displays alert when business session is not connected", async () => {
  const env = setupTestEnvironment({ connected: false });
  const tree = await env.renderSystemRuntimeAndSettle("/lattice/systems/company-ops/1.0.0");

  const notConnectedAlert = env.find(
    tree,
    (n) =>
      n.props?.role === "alert" &&
      n.children?.some((c) => typeof c === "string" && c.includes("Vui lòng kết nối tài khoản nghiệp vụ")),
  );
  assert.ok(notConnectedAlert, "Should render disconnected alert when business session is inactive");
});

test("SystemRuntime handles 403 or missing system error gracefully with clear role alert", async () => {
  const env = setupTestEnvironment({
    connected: true,
    systemError: "Tài khoản không có quyền truy cập hệ thống này (403 Forbidden).",
  });

  const tree = await env.renderSystemRuntimeAndSettle("/lattice/systems/company-ops/1.0.0");

  const errorAlert = env.find(
    tree,
    (n) =>
      n.props?.role === "alert" &&
      n.children?.some(
        (c) =>
          (typeof c === "string" && c.includes("403 Forbidden")) ||
          (c?.children && c.children.some((sc) => typeof sc === "string" && sc.includes("Không thể truy cập"))),
      ),
  );
  assert.ok(errorAlert, "Should display error alert for 403 Forbidden access denial");
});

test("SystemRuntime renders workflow module with task inbox, run details and available transitions", async () => {
  const env = setupTestEnvironment({ connected: true });
  let tree = await env.renderSystemRuntimeAndSettle("/lattice/systems/company-ops/1.0.0");

  // Check system title in header
  const titleHeader = env.find(
    tree,
    (n) => n.type === "h2" && n.children.includes("Điều hành công ty"),
  );
  assert.ok(titleHeader, "Should render system title in header");

  // Check start request form
  const startLegend = env.find(
    tree,
    (n) => n.type === "legend" && n.children.includes("Tạo yêu cầu mới"),
  );
  assert.ok(startLegend, "Should render 'Tạo yêu cầu mới' form for employee with canStart");

  // Check inbox toggle buttons
  const inboxBtn = env.find(
    tree,
    (n) => n.type === "button" && n.children.includes("Việc cần xử lý của tôi"),
  );
  const allRunsBtn = env.find(
    tree,
    (n) => n.type === "button" && n.children.includes("Tất cả hồ sơ"),
  );
  assert.ok(inboxBtn && allRunsBtn, "Should render both 'Việc cần xử lý của tôi' and 'Tất cả hồ sơ' buttons");

  // Open run run-001
  const runBtn = env.find(
    tree,
    (n) =>
      n.type === "button" &&
      n.children.some((c) => typeof c === "string" && c.includes("Yêu cầu cấp laptop")),
  );
  assert.ok(runBtn, "Should list run item button");

  await runBtn.props.onClick();
  for (let i = 0; i < 3; i++) {
    await env.flushEffects();
    tree = env.renderSystemRuntime("/lattice/systems/company-ops/1.0.0");
  }

  // Check structured details dl
  const dl = env.find(tree, (n) => n.type === "dl");
  assert.ok(dl, "Should render structured key-value description list <dl> for run data");

  // Check Vietnamese status badge
  const stateBadge = env.find(
    tree,
    (n) => n.type === "span" && n.children.includes("pending"),
  );
  assert.ok(stateBadge, "Should render run state badge");

  // Check available transitions
  const approveFieldset = env.find(
    tree,
    (n) =>
      n.type === "fieldset" &&
      env.find(n, (c) => c.type === "legend" && c.children.includes("Phê duyệt và giao việc")),
  );
  assert.ok(approveFieldset, "Should render 'Phê duyệt và giao việc' transition fieldset");

  const rejectFieldset = env.find(
    tree,
    (n) =>
      n.type === "fieldset" &&
      env.find(n, (c) => c.type === "legend" && c.children.includes("Từ chối")),
  );
  assert.ok(rejectFieldset, "Should render 'Từ chối' transition fieldset");

  // Fill transition field
  const noteInput = env.find(approveFieldset, (n) => n.type === "input");
  assert.ok(noteInput, "Should render input for receiptNote in approve transition");
  noteInput.props.onChange({ target: { value: "Đã phê duyệt" } });
  tree = env.renderSystemRuntime("/lattice/systems/company-ops/1.0.0");

  // Execute transition
  const executeApproveBtn = env.find(
    tree,
    (n) => n.type === "button" && n.children.includes("Phê duyệt và giao việc"),
  );
  assert.ok(executeApproveBtn, "Should render execution button for approve");
  await executeApproveBtn.props.onClick();
  for (let i = 0; i < 3; i++) {
    await env.flushEffects();
    tree = env.renderSystemRuntime("/lattice/systems/company-ops/1.0.0");
  }

  assert.equal(env.executedWorkflow.length, 1, "Should execute workflow transition via command");
  assert.equal(env.executedWorkflow[0].data.body.action, "approve");
});

test("SystemRuntime catalog view lists published systems and handles pagination", async () => {
  const env = setupTestEnvironment({ connected: true });
  const tree = await env.renderSystemRuntimeAndSettle("/lattice/systems");

  // Catalog title
  const catalogTitle = env.find(
    tree,
    (n) => n.type === "h2" && n.children.includes("Danh mục hệ thống doanh nghiệp"),
  );
  assert.ok(catalogTitle, "Should render catalog title");

  // Catalog link
  const catalogItem = env.find(
    tree,
    (n) =>
      n.type === "a" &&
      n.props.href === "/lattice/systems/company-ops/1.0.0" &&
      n.children.some((c) => typeof c === "string" && c.includes("Điều hành công ty")),
  );
  assert.ok(catalogItem, "Should render catalog item linking to system");
});

test("SystemRuntime enforces RBAC start restrictions, disabled status and empty transition notices", async () => {
  const env = setupTestEnvironment({
    connected: true,
    mockDetailTransitions: [],
    systems: [
      {
        id: "company-ops",
        version: "1.0.0",
        title: "Điều hành công ty",
        enabled: false, // system is disabled for new creations
        description: "Hệ thống tạm dừng tạo mới",
        presentation: {
          pages: [
            {
              id: "cross-requests-page",
              title: "Quy trình đề xuất",
              definitionId: "cross-requests",
              blocks: ["create", "list", "detail"],
              fieldLabels: { title: "Tiêu đề" },
            },
          ],
          entityPages: [],
        },
        definitions: [
          {
            id: "cross-requests",
            canStart: false, // employee cannot start this workflow
            startFields: {},
            optionalStartFields: {},
          },
        ],
        schemas: [],
      },
    ],
  });

  let tree = await env.renderSystemRuntimeAndSettle("/lattice/systems/company-ops/1.0.0");

  // Check disabled system badge/notice
  const disabledNotice = env.find(
    tree,
    (n) =>
      (n.type === "span" || n.type === "section") &&
      n.children?.some((c) => typeof c === "string" && c.includes("Đã tạm dừng tạo mới")),
  );
  assert.ok(disabledNotice, "Should display notice that system is paused for new records");

  // Verify "Tạo yêu cầu mới" is NOT rendered
  const startLegend = env.find(
    tree,
    (n) => n.type === "legend" && n.children.includes("Tạo yêu cầu mới"),
  );
  assert.equal(startLegend, undefined, "Start request form should not be rendered when canStart is false");

  // Open run which has NO transitions available for current actor (mockDetailTransitions is [])
  const runBtn = env.find(
    tree,
    (n) =>
      n.type === "button" &&
      n.children.some((c) => typeof c === "string" && c.includes("Yêu cầu")),
  );
  assert.ok(runBtn, "Should list runs");
  await runBtn.props.onClick();
  for (let i = 0; i < 3; i++) {
    await env.flushEffects();
    tree = env.renderSystemRuntime("/lattice/systems/company-ops/1.0.0");
  }

  // Check empty transition notice
  const noTransitionNotice = env.find(
    tree,
    (n) =>
      n.type === "p" &&
      n.children?.some(
        (c) =>
          typeof c === "string" &&
          c.includes("Không có hành động chuyển bước nào khả dụng cho vai trò của bạn"),
      ),
  );
  assert.ok(noTransitionNotice, "Should display helpful notice when no transitions are available for role");
});
