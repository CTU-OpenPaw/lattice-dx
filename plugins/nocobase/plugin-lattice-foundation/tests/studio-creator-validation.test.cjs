/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  Module = require("node:module");

const {
  blankRecipe,
  companyOperationsRecipe,
  exampleRecipe,
  validateRecipe,
} = require("../src/client/system-model");

test("validateRecipe accepts valid standard and company operations recipes", () => {
  const exampleResult = validateRecipe(exampleRecipe());
  assert.equal(exampleResult.valid, true);
  assert.equal(exampleResult.issues.length, 0);

  const blankResult = validateRecipe(blankRecipe());
  assert.equal(blankResult.valid, true);
  assert.equal(blankResult.issues.length, 0);

  const companyResult = validateRecipe(companyOperationsRecipe());
  assert.equal(companyResult.valid, true);
  assert.equal(companyResult.issues.length, 0);
});

test("validateRecipe detects system metadata errors", () => {
  assert.equal(validateRecipe(null).valid, false);
  assert.equal(validateRecipe({}).valid, false);

  // Invalid ID
  const invalidId = { ...exampleRecipe(), id: "UPPERCASE_INVALID!" };
  const resId = validateRecipe(invalidId);
  assert.equal(resId.valid, false);
  assert.ok(resId.issues.some((i) => i.includes("Mã hệ thống")));

  // Empty title
  const emptyTitle = { ...exampleRecipe(), title: "   " };
  const resTitle = validateRecipe(emptyTitle);
  assert.equal(resTitle.valid, false);
  assert.ok(resTitle.issues.some((i) => i.includes("Tên hệ thống")));

  // Invalid version
  const badVer = { ...exampleRecipe(), version: "v1-beta" };
  const resVer = validateRecipe(badVer);
  assert.equal(resVer.valid, false);
  assert.ok(resVer.issues.some((i) => i.includes("semver")));
});

test("validateRecipe detects module, field, and relationship errors", () => {
  // Empty pages and schemas
  const emptySystem = {
    format: "latticedx.system-recipe",
    formatVersion: 1,
    id: "empty-sys",
    version: "1.0.0",
    title: "Empty System",
    pages: [],
    schemas: [],
    entityPages: [],
  };
  const resEmpty = validateRecipe(emptySystem);
  assert.equal(resEmpty.valid, false);
  assert.ok(resEmpty.issues.some((i) => i.includes("ít nhất một module quy trình")));

  // Reserved field name
  const reservedField = {
    ...exampleRecipe(),
    pages: [
      {
        ...exampleRecipe().pages[0],
        fields: [{ name: "handlerId", label: "Handler", type: "text", required: true }],
      },
    ],
  };
  const resReserved = validateRecipe(reservedField);
  assert.equal(resReserved.valid, false);
  assert.ok(resReserved.issues.some((i) => i.includes("trùng với trường dành riêng")));

  // Duplicate module IDs
  const dupPages = {
    ...exampleRecipe(),
    pages: [
      { ...exampleRecipe().pages[0], id: "req-dup" },
      { ...exampleRecipe().pages[0], id: "req-dup" },
    ],
  };
  const resDup = validateRecipe(dupPages);
  assert.equal(resDup.valid, false);
  assert.ok(resDup.issues.some((i) => i.includes("Trùng mã module")));

  // Invalid relation target
  const badRelation = {
    ...companyOperationsRecipe(),
    schemas: [
      {
        id: "schema-1",
        title: "Schema 1",
        fields: { name: { type: "text", required: true } },
        relations: {
          target: { targetSchemaId: "non-existent-schema" },
        },
      },
    ],
  };
  const resRel = validateRecipe(badRelation);
  assert.equal(resRel.valid, false);
  assert.ok(resRel.issues.some((i) => i.includes("không tồn tại")));
});

function setupStudioEnvironment() {
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
      if (!slots[i])
        slots[i] = {
          value: typeof initial === "function" ? initial() : initial,
        };
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
  };
  const studioCalls = [];
  const session = {
    connection: { connected: true, capabilities: {} },
    busy: false,
    commands: {
      uncertain: false,
      execute: async (op, payload) => {
        studioCalls.push({ op, payload });
        return { id: payload?.id || "saved", revision: 1 };
      },
    },
    workflow: { uncertain: false },
    report: () => {},
    api: {
      studio: async (op, args) => {
        studioCalls.push({ op, args });
        if (op === "drafts") return { items: [], page: { hasMore: false } };
        if (op === "plan") return { preview: { conflicts: [], dependencyErrors: [] }, manifest: { bundle: { definitions: [] } } };
        return {};
      },
    },
  };

  const shell = {
    h,
    box: { border: "1px solid" },
    inputStyle: {},
    labels: {},
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
    download: () => {},
    useSession: () => session,
    Frame: ({ children }) => ({ type: "div", props: {}, children }),
  };

  const Designer = () => ({ type: "div", props: { "data-designer": true }, children: [] });
  const load = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent?.filename.endsWith("system-studio.js") && request === "./system-shell")
      return { createSystemShell: () => shell };
    if (parent?.filename.endsWith("system-studio.js") && request === "./entity-page-designer")
      return { createEntityPageDesigner: () => Designer };
    return load.call(this, request, parent, isMain);
  };
  let screens;
  try {
    screens = require("../src/client/system-studio").createSystemScreens({}, React);
  } finally {
    Module._load = load;
  }

  function find(tree, predicate) {
    if (!tree || typeof tree !== "object") return undefined;
    if (predicate(tree)) return tree;
    return tree.children?.map((c) => find(c, predicate)).find(Boolean);
  }
  function findAll(tree, predicate, acc = []) {
    if (!tree || typeof tree !== "object") return acc;
    if (predicate(tree)) acc.push(tree);
    tree.children?.forEach((c) => findAll(c, predicate, acc));
    return acc;
  }

  return {
    render() {
      index = 0;
      return screens.Studio();
    },
    find,
    findAll,
    studioCalls,
  };
}

test("Studio renders template buttons, diagnostics checklist, and module controls", async () => {
  const env = setupStudioEnvironment();
  let tree = env.render();

  // Find buttons
  const blankBtn = env.find(tree, (n) => n.type === "button" && n.children?.[0] === "Tạo hệ thống trống");
  assert.ok(blankBtn, "Must render 'Tạo hệ thống trống' button");

  const companyBtn = env.find(tree, (n) => n.type === "button" && n.children?.[0] === "Mẫu điều hành công ty");
  assert.ok(companyBtn, "Must render 'Mẫu điều hành công ty' button");

  const exampleBtn = env.find(tree, (n) => n.type === "button" && n.children?.[0] === "Mẫu mới");
  assert.ok(exampleBtn, "Must render 'Mẫu mới' button");

  // Verify Diagnostics Panel renders
  const diagTitle = env.find(tree, (n) => n.children?.[0] === "Kiểm tra cấu hình (Diagnostics)");
  assert.ok(diagTitle, "Must render diagnostics section");

  // Click 'Mẫu điều hành công ty'
  companyBtn.props.onClick();
  tree = env.render();

  // Check module ID has cross-requests
  const idInput = env.find(tree, (n) => n.props?.value === "company-ops");
  assert.ok(idInput, "Recipe should update to company-ops");

  // Check diagnostics shows valid
  const diagValid = env.find(tree, (n) => typeof n.children?.[0] === "string" && n.children[0].includes("Cấu hình hợp lệ: company-ops"));
  assert.ok(diagValid, "Diagnostics must indicate valid configuration");

  // Click 'Tạo hệ thống trống'
  blankBtn.props.onClick();
  tree = env.render();
  const blankIdInput = env.find(tree, (n) => typeof n.props?.value === "string" && n.props.value.startsWith("system-"));
  assert.ok(blankIdInput, "Recipe should update to blank system");
});
