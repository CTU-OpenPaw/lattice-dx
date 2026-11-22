/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const designer = require("../src/client/entity-page-designer");
test("new data pages bind an owned version-one schema without changing workflow pages", () => {
  const recipe = { id: "ops", version: "1.0.0", pages: [{ id: "requests" }] };
  const next = designer.addDataPage(recipe);
  assert.deepEqual(next.pages, recipe.pages);
  assert.equal(recipe.schemas, undefined);
  assert.equal(next.schemas[0].id, "ops-1-0-0-data-1");
  assert.equal(next.entityPages[0].schemaId, next.schemas[0].id);
  assert.equal(next.entityPages[0].schemaVersion, 1);
  assert.deepEqual(next.entityPages[0].fields, ["name"]);
  assert.notEqual(
    designer.addDataPage(next).entityPages[1].id,
    next.entityPages[0].id,
  );
});
test("schema rename updates page bindings and relation targets immutably", () => {
  const recipe = designer.addDataPage({
    id: "ops",
    version: "1.0.0",
    pages: [],
  });
  recipe.schemas[0].relations.parent = { targetSchemaId: recipe.schemas[0].id };
  const next = designer.renameSchema(recipe, 0, "ops-new");
  assert.equal(next.entityPages[0].schemaId, "ops-new");
  assert.equal(next.schemas[0].relations.parent.targetSchemaId, "ops-new");
  assert.equal(recipe.schemas[0].id, "ops-1-0-0-data-1");
});
test("query editor accepts only object filters and sort configuration and never evaluates text", () => {
  assert.deepEqual(
    designer.parsePageQuery(
      '{"filters":[{"field":"name","operator":"eq","value":"hello"}]}',
    ),
    { filters: [{ field: "name", operator: "eq", value: "hello" }] },
  );
  assert.equal(designer.parsePageQuery("  "), undefined);
  for (const text of [
    "[]",
    "null",
    '{"limit":10}',
    '{"filters":{}}',
    '{"sort":[]}',
    "(()=>{throw 1})()",
  ])
    assert.throws(() => designer.parsePageQuery(text));
});
test("new data page actions are usable without a declared relation", () => {
  const page = designer.addDataPage({ id: "ops", version: "1.0.0", pages: [] })
    .entityPages[0];
  assert.deepEqual(page.actions, ["create", "update", "archive"]);
});
test("designer updates shared fields, enum choices, relations and selected page schema through native controls", () => {
  const h = (type, props, ...children) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter(Boolean),
  });
  const find = (tree, predicate) =>
    !tree || typeof tree !== "object"
      ? undefined
      : predicate(tree)
        ? tree
        : tree.children?.map((child) => find(child, predicate)).find(Boolean);
  let recipe = designer.addDataPage({ id: "ops", version: "1.0.0", pages: [] });
  const Designer = designer.createEntityPageDesigner(
    {},
    {
      h,
      box: {},
      button: (label, onClick, disabled) =>
        h("button", { onClick, disabled }, label),
      field: (label, value, onChange) => h("field", { label, value, onChange }),
    },
  );
  const render = () =>
    Designer({
      recipe,
      onChange: (next) => {
        recipe = next;
      },
    });
  find(
    render(),
    (n) => n.type === "field" && n.props.label === "Tên trường dữ liệu",
  ).props.onChange("label");
  assert.deepEqual(recipe.entityPages[0].fields, ["label"]);
  find(
    render(),
    (n) => n.type === "select" && n.props["aria-label"] === "Kiểu dữ liệu",
  ).props.onChange({ target: { value: "enum" } });
  assert.deepEqual(recipe.schemas[0].fields.label.choices, ["Lựa chọn 1"]);
  find(
    render(),
    (n) => n.type === "field" && n.props.label === "Lựa chọn (dấu phẩy)",
  ).props.onChange("One,Two");
  assert.deepEqual(recipe.schemas[0].fields.label.choices, ["One", "Two"]);
  find(
    render(),
    (n) => n.type === "button" && n.children[0] === "Thêm quan hệ",
  ).props.onClick();
  assert.equal(
    recipe.schemas[0].relations.relation1.targetSchemaId,
    recipe.schemas[0].id,
  );
  recipe = designer.addDataPage(recipe);
  const oldId = recipe.schemas[0].id;
  find(
    render(),
    (n) => n.type === "select" && n.props["aria-label"] === "Lược đồ của trang",
  ).props.onChange({ target: { value: recipe.schemas[1].id } });
  assert.notEqual(recipe.entityPages[0].schemaId, oldId);
  assert.deepEqual(recipe.entityPages[0].fields, ["name"]);
});
test("valid imported schemas without optional relations render and support native relation editing and rename", () => {
  const h = (type, props, ...children) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter(Boolean),
  });
  const find = (tree, predicate) =>
    !tree || typeof tree !== "object"
      ? undefined
      : predicate(tree)
        ? tree
        : tree.children?.map((child) => find(child, predicate)).find(Boolean);
  const imported = designer.addDataPage({
    id: "imported",
    version: "1.0.0",
    pages: [],
  });
  delete imported.schemas[0].relations;
  const renamed = designer.renameSchema(imported, 0, "imported-copy");
  assert.deepEqual(renamed.schemas[0].relations, {});
  assert.equal(renamed.entityPages[0].schemaId, "imported-copy");
  assert.equal(imported.schemas[0].relations, undefined);
  let recipe = imported;
  const Designer = designer.createEntityPageDesigner(
    {},
    {
      h,
      box: {},
      button: (label, onClick, disabled) =>
        h("button", { onClick, disabled }, label),
      field: (label, value, onChange) => h("field", { label, value, onChange }),
    },
  );
  const render = () =>
    Designer({
      recipe,
      onChange: (next) => {
        recipe = next;
      },
    });
  assert.ok(
    find(
      render(),
      (node) => node.type === "field" && node.props.label === "Tên lược đồ",
    ),
  );
  find(
    render(),
    (node) => node.type === "button" && node.children[0] === "Thêm quan hệ",
  ).props.onClick();
  assert.deepEqual(recipe.schemas[0].relations, {
    relation1: { targetSchemaId: recipe.schemas[0].id },
  });
  find(
    render(),
    (node) => node.type === "field" && node.props.label === "Mã lược đồ đích",
  ).props.onChange("published-target");
  assert.equal(
    recipe.schemas[0].relations.relation1.targetSchemaId,
    "published-target",
  );
  find(
    render(),
    (node) => node.type === "button" && node.children[0] === "Xóa quan hệ",
  ).props.onClick();
  assert.deepEqual(recipe.schemas[0].relations, {});
});
