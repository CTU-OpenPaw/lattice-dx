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
function environment(system) {
  const slots = [],
    effects = [],
    pending = [],
    calls = [];
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
      if (!slots[i] || deps.some((v, k) => v !== slots[i].deps[k])) {
        slots[i] = { deps };
        effects.push(fn);
      }
    },
  };
  const session = {
    connection: { connected: true, capabilities: {} },
    busy: false,
    commands: { uncertain: false, execute: async () => {} },
    workflow: { uncertain: false },
    report: () => {},
    api: {
      studio: async (op) => {
        calls.push(op);
        return op === "app" ? system : { items: [] };
      },
      workflow: async (op) => {
        calls.push("workflow:" + op);
        return { items: [] };
      },
    },
    act: (fn) => {
      const promise = Promise.resolve().then(fn);
      pending.push(promise);
      return promise;
    },
  };
  const EntityPage = () => {},
    Designer = () => {},
    Frame = () => {};
  const shell = {
    h,
    box: {},
    inputStyle: {},
    labels: {},
    button: (label, onClick, disabled) =>
      h("button", { onClick, disabled }, label),
    field: (label, value, onChange) => h("field", { label, value, onChange }),
    json: (v) => h("json", { value: v }),
    download: () => {},
    useSession: () => session,
    Frame,
  };
  const load = Module._load;
  Module._load = function (request, parent, isMain) {
    if (
      parent?.filename.endsWith("system-studio.js") &&
      request === "./system-shell"
    )
      return { createSystemShell: () => shell };
    if (
      parent?.filename.endsWith("system-studio.js") &&
      request === "./entity-page"
    )
      return { createEntityPage: () => EntityPage };
    if (
      parent?.filename.endsWith("system-studio.js") &&
      request === "./entity-page-designer"
    )
      return { createEntityPageDesigner: () => Designer };
    return load.call(this, request, parent, isMain);
  };
  let screens;
  try {
    screens = require("../src/client/system-studio").createSystemScreens(
      {},
      React,
    );
  } finally {
    Module._load = load;
  }
  return {
    calls,
    session,
    EntityPage,
    Designer,
    render(name) {
      index = 0;
      return screens[name]();
    },
    async flush() {
      for (const effect of effects.splice(0)) effect();
      await Promise.all(pending.splice(0));
    },
    find(tree, predicate) {
      if (!tree || typeof tree !== "object") return undefined;
      return predicate(tree)
        ? tree
        : tree.children
            ?.map((child) => this.find(child, predicate))
            .find(Boolean);
    },
  };
}
test("data-only system loads without workflow membership and mounts pinned schema page", async () => {
  const page = {
    id: "data",
    title: "Data",
    schemaId: "inventory",
    schemaVersion: 1,
    fields: ["name"],
    blocks: ["list"],
    actions: [],
  };
  const system = {
    title: "Inventory",
    version: "1.0.0",
    enabled: true,
    definitions: [],
    schemas: [
      {
        id: "inventory",
        version: 1,
        fields: { name: { type: "text" } },
        relations: {},
      },
    ],
    presentation: { pages: [], entityPages: [page] },
  };
  const previous = global.location;
  global.location = { pathname: "/lattice/systems/inventory/1.0.0" };
  try {
    const env = environment(system);
    env.render("SystemRuntime");
    await env.flush();
    const tree = env.render("SystemRuntime");
    assert.deepEqual(env.calls, ["app"]);
    const data = env.find(tree, (node) => node.type === env.EntityPage);
    assert.ok(data);
    assert.equal(data.props.key, page.id);
    assert.deepEqual(data.props.schemas, system.schemas);
    assert.equal(data.props.page, page);
    assert.equal(data.props.enabled, true);
  } finally {
    global.location = previous;
  }
});
test("mixed system keeps workflow membership and can select a data page", async () => {
  const page = {
    id: "records",
    title: "Records",
    schemaId: "records",
    schemaVersion: 1,
    fields: [],
    blocks: ["list"],
    actions: [],
  };
  const system = {
    title: "Mixed",
    version: "1.0.0",
    enabled: true,
    definitions: [{ id: "flow" }],
    schemas: [],
    presentation: {
      pages: [
        {
          id: "requests",
          title: "Requests",
          definitionId: "flow",
          fieldLabels: {},
        },
      ],
      entityPages: [page],
    },
  };
  const previous = global.location;
  global.location = { pathname: "/lattice/systems/mixed/1.0.0" };
  try {
    const env = environment(system);
    env.render("SystemRuntime");
    await env.flush();
    let tree = env.render("SystemRuntime");
    assert.deepEqual(env.calls, ["app", "workflow:member"]);
    const nav = env.find(
      tree,
      (node) => node.type === "button" && node.children[0] === "Records",
    );
    assert.ok(nav);
    nav.props.onClick();
    tree = env.render("SystemRuntime");
    assert.equal(
      env.find(tree, (node) => node.type === env.EntityPage).props.page,
      page,
    );
  } finally {
    global.location = previous;
  }
});
test("Studio mounts shared schema designer and allows removing its final workflow after a data page exists", () => {
  const env = environment({});
  let tree = env.render("Studio");
  const designer = env.find(tree, (node) => node.type === env.Designer);
  assert.ok(designer);
  const recipe = { ...designer.props.recipe, entityPages: [{ id: "data" }] };
  designer.props.onChange(recipe);
  tree = env.render("Studio");
  const remove = env.find(
    tree,
    (node) => node.type === "button" && node.children[0] === "Xóa module",
  );
  assert.equal(remove.props.disabled, false);
  remove.props.onClick();
  tree = env.render("Studio");
  assert.deepEqual(
    env.find(tree, (node) => node.type === env.Designer).props.recipe.pages,
    [],
  );
});
