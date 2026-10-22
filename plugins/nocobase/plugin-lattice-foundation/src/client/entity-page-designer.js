// SPDX-License-Identifier: Apache-2.0
const blockNames = {
  create: "Tạo mới",
  list: "Danh sách",
  detail: "Chi tiết",
  relations: "Quan hệ",
  history: "Lịch sử",
};
const actionNames = {
  create: "Tạo",
  update: "Sửa",
  archive: "Lưu trữ",
  link: "Liên kết",
  unlink: "Bỏ liên kết",
};
function addDataPage(recipe) {
  const schemas = recipe.schemas || [],
    pages = recipe.entityPages || [];
  let number = 1;
  while (
    [...(recipe.pages || []), ...pages].some(
      (page) => page.id === "data-" + number,
    ) ||
    schemas.some(
      (schema) =>
        schema.id ===
        `${recipe.id}-${recipe.version.replaceAll(".", "-")}-data-${number}`,
    )
  )
    number++;
  const schema = {
    id: `${recipe.id}-${recipe.version.replaceAll(".", "-")}-data-${number}`,
    title: "Dữ liệu " + number,
    fields: { name: { type: "text", required: true } },
    relations: {},
  };
  return {
    ...recipe,
    schemas: [...schemas, schema],
    entityPages: [
      ...pages,
      {
        id: "data-" + number,
        title: schema.title,
        schemaId: schema.id,
        schemaVersion: 1,
        fields: Object.keys(schema.fields),
        blocks: Object.keys(blockNames),
        actions: ["create", "update", "archive"],
      },
    ],
  };
}
function renameSchema(recipe, index, id) {
  const previous = recipe.schemas[index].id;
  return {
    ...recipe,
    schemas: recipe.schemas.map((schema, i) => ({
      ...schema,
      ...(i === index ? { id } : {}),
      relations: Object.fromEntries(
        Object.entries(schema.relations || {}).map(([name, relation]) => [
          name,
          {
            ...relation,
            targetSchemaId:
              relation.targetSchemaId === previous
                ? id
                : relation.targetSchemaId,
          },
        ]),
      ),
    })),
    entityPages: (recipe.entityPages || []).map((page) =>
      page.schemaId === previous ? { ...page, schemaId: id } : page,
    ),
  };
}
function parsePageQuery(text) {
  if (!text.trim()) return undefined;
  const value = JSON.parse(text);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["filters", "sort"].includes(key)) ||
    (value.filters !== undefined && !Array.isArray(value.filters)) ||
    (value.sort !== undefined &&
      (!value.sort ||
        typeof value.sort !== "object" ||
        Array.isArray(value.sort)))
  )
    throw Error("Truy vấn chỉ nhận filters (mảng) và sort (đối tượng).");
  return value;
}
function createEntityPageDesigner(React, { h, box, button, field }) {
  function QueryEditor({ page, onChange }) {
    const [text, setText] = React.useState(() =>
        page.query ? JSON.stringify(page.query, null, 2) : "",
      ),
      [error, setError] = React.useState("");
    React.useEffect(() => {
      setText(page.query ? JSON.stringify(page.query, null, 2) : "");
      setError("");
    }, [page.query]);
    return h(
      "details",
      null,
      h("summary", null, "Bộ lọc / sắp xếp JSON"),
      h(
        "p",
        null,
        'Ví dụ: {"filters":[{"field":"name","operator":"contains","value":"abc"}],"sort":{"field":"name","direction":"asc"}}. Kiểm tra cấu hình để xác thực kiểu và trường.',
      ),
      h("textarea", {
        "aria-label": "Truy vấn trang dữ liệu",
        value: text,
        rows: 5,
        style: { width: "100%" },
        onChange: (e) => setText(e.target.value),
      }),
      button("Áp dụng truy vấn", () => {
        try {
          const query = parsePageQuery(text),
            next = { ...page };
          if (query) next.query = query;
          else delete next.query;
          onChange(next);
          setError("");
        } catch (error) {
          setError(error.message);
        }
      }),
      error && h("p", { role: "alert" }, error),
    );
  }
  return function EntityPageDesigner({ recipe, onChange }) {
    const schemas = recipe.schemas || [],
      pages = recipe.entityPages || [];
    const updateSchema = (index, change) =>
      onChange({
        ...recipe,
        schemas: schemas.map((schema, i) =>
          i === index ? change(schema) : schema,
        ),
      });
    const updatePage = (index, change) =>
      onChange({
        ...recipe,
        entityPages: pages.map((page, i) =>
          i === index ? change(page) : page,
        ),
      });
    const select = (label, value, options, change) =>
      h(
        "label",
        null,
        label,
        " ",
        h(
          "select",
          {
            "aria-label": label,
            value,
            onChange: (e) => change(e.target.value),
          },
          ...options.map(([id, title]) =>
            h("option", { key: id, value: id }, title),
          ),
        ),
      );
    const check = (label, checked, change, disabled = false) =>
      h(
        "label",
        {
          key: label,
          style: { display: "inline-block", margin: "6px 14px 6px 0" },
        },
        h("input", {
          type: "checkbox",
          checked,
          disabled,
          onChange: (e) => change(e.target.checked),
        }),
        " " + label,
      );
    const choices = (label, values, options, change) =>
      h(
        "div",
        null,
        h("strong", null, label + " "),
        ...Object.entries(options).map(([id, title]) =>
          check(title, values.includes(id), (checked) =>
            change(
              checked
                ? [...values, id]
                : values.filter((value) => value !== id),
            ),
          ),
        ),
      );
    function updateField(index, name, value) {
      updateSchema(index, (schema) => ({
        ...schema,
        fields: { ...schema.fields, [name]: value },
      }));
    }
    function renameEntry(index, kind, name, nextName) {
      const schema = schemas[index];
      if (Object.hasOwn(schema[kind], nextName) && nextName !== name) return;
      const next = {
        ...recipe,
        schemas: schemas.map((item, i) =>
          i === index
            ? {
                ...item,
                [kind]: Object.fromEntries(
                  Object.entries(item[kind]).map(([key, value]) => [
                    key === name ? nextName : key,
                    value,
                  ]),
                ),
              }
            : item,
        ),
      };
      if (kind === "fields")
        next.entityPages = pages.map((page) =>
          page.schemaId === schema.id
            ? {
                ...page,
                fields: page.fields.map((field) =>
                  field === name ? nextName : field,
                ),
              }
            : page,
        );
      onChange(next);
    }
    return h(
      "section",
      { style: box },
      h("h2", null, "Trang dữ liệu dùng lại"),
      h(
        "p",
        null,
        "Thiết kế lược đồ, chọn block và hành động cho từng trang. Quyền dữ liệu do máy chủ kiểm tra. Lược đồ được xuất bản ở phiên bản 1 khi cài gói; dùng mã lược đồ mới khi thay đổi cấu trúc trong phiên bản hệ thống mới.",
      ),
      button(
        "Thêm trang dữ liệu và lược đồ",
        () => onChange(addDataPage(recipe)),
        schemas.length >= 10 || pages.length >= 10,
      ),
      ...schemas.map((schema, index) =>
        h(
          "section",
          { key: "schema-" + index, style: box },
          h("h3", null, "Lược đồ " + (index + 1)),
          field("Mã lược đồ", schema.id, (value) =>
            onChange(renameSchema(recipe, index, value)),
          ),
          field("Tên lược đồ", schema.title, (value) =>
            updateSchema(index, (s) => ({ ...s, title: value })),
          ),
          ...Object.entries(schema.fields).map(([name, item], j) =>
            h(
              "div",
              { key: j },
              field("Tên trường dữ liệu", name, (value) =>
                renameEntry(index, "fields", name, value),
              ),
              select(
                "Kiểu dữ liệu",
                item.type,
                ["text", "integer", "decimal", "boolean", "date", "enum"].map(
                  (type) => [type, type],
                ),
                (type) => {
                  const next = { ...item, type };
                  delete next.choices;
                  if (type === "enum") next.choices = ["Lựa chọn 1"];
                  if (type !== "text") delete next.maxLength;
                  updateField(index, name, next);
                },
              ),
              check("Bắt buộc", !!item.required, (required) =>
                updateField(index, name, { ...item, required }),
              ),
              item.type === "enum" &&
                field("Lựa chọn (dấu phẩy)", item.choices.join(","), (value) =>
                  updateField(index, name, {
                    ...item,
                    choices: value.split(",").map((v) => v.trim()),
                  }),
                ),
              button("Xóa trường dữ liệu", () =>
                onChange({
                  ...recipe,
                  schemas: schemas.map((s, i) =>
                    i === index
                      ? {
                          ...s,
                          fields: Object.fromEntries(
                            Object.entries(s.fields).filter(
                              ([key]) => key !== name,
                            ),
                          ),
                        }
                      : s,
                  ),
                  entityPages: pages.map((page) =>
                    page.schemaId === schema.id
                      ? {
                          ...page,
                          fields: page.fields.filter((key) => key !== name),
                        }
                      : page,
                  ),
                }),
              ),
            ),
          ),
          button(
            "Thêm trường dữ liệu",
            () =>
              updateSchema(index, (s) => {
                let n = 1;
                while (Object.hasOwn(s.fields, "field" + n)) n++;
                return {
                  ...s,
                  fields: {
                    ...s.fields,
                    ["field" + n]: { type: "text", required: false },
                  },
                };
              }),
            Object.keys(schema.fields).length >= 50,
          ),
          h("h4", null, "Quan hệ"),
          ...Object.entries(schema.relations || {}).map(([name, relation], j) =>
            h(
              "div",
              { key: j },
              field("Tên quan hệ", name, (value) =>
                renameEntry(index, "relations", name, value),
              ),
              field("Mã lược đồ đích", relation.targetSchemaId, (value) =>
                updateSchema(index, (s) => ({
                  ...s,
                  relations: {
                    ...s.relations,
                    [name]: { targetSchemaId: value },
                  },
                })),
              ),
              button("Xóa quan hệ", () =>
                updateSchema(index, (s) => ({
                  ...s,
                  relations: Object.fromEntries(
                    Object.entries(s.relations || {}).filter(
                      ([key]) => key !== name,
                    ),
                  ),
                })),
              ),
            ),
          ),
          button(
            "Thêm quan hệ",
            () =>
              updateSchema(index, (s) => {
                let n = 1;
                while (Object.hasOwn(s.relations || {}, "relation" + n)) n++;
                return {
                  ...s,
                  relations: {
                    ...s.relations,
                    ["relation" + n]: { targetSchemaId: s.id },
                  },
                };
              }),
            Object.keys(schema.relations || {}).length >= 20,
          ),
          button(
            "Xóa lược đồ",
            () =>
              onChange({
                ...recipe,
                schemas: schemas.filter((_, i) => i !== index),
              }),
            pages.some((page) => page.schemaId === schema.id),
          ),
        ),
      ),
      ...pages.map((page, index) => {
        const schema = schemas.find((s) => s.id === page.schemaId);
        return h(
          "section",
          { key: "page-" + index, style: box },
          h("h3", null, "Trang dữ liệu " + (index + 1)),
          field("Mã trang dữ liệu", page.id, (value) =>
            updatePage(index, (p) => ({ ...p, id: value })),
          ),
          field("Tên trang dữ liệu", page.title, (value) =>
            updatePage(index, (p) => ({ ...p, title: value })),
          ),
          select(
            "Lược đồ của trang",
            page.schemaId,
            schemas.map((s) => [s.id, s.title + " · " + s.id]),
            (schemaId) =>
              updatePage(index, (p) => {
                const next = {
                  ...p,
                  schemaId,
                  schemaVersion: 1,
                  fields: Object.keys(
                    schemas.find((s) => s.id === schemaId).fields,
                  ),
                };
                delete next.query;
                return next;
              }),
          ),
          choices(
            "Trường hiển thị",
            page.fields,
            Object.fromEntries(
              Object.keys(schema?.fields || {}).map((name) => [name, name]),
            ),
            (fields) => updatePage(index, (p) => ({ ...p, fields })),
          ),
          choices(
            "Block (theo thứ tự chọn)",
            page.blocks,
            blockNames,
            (blocks) => updatePage(index, (p) => ({ ...p, blocks })),
          ),
          choices("Hành động", page.actions, actionNames, (actions) =>
            updatePage(index, (p) => ({ ...p, actions })),
          ),
          h(QueryEditor, {
            page,
            onChange: (next) => updatePage(index, () => next),
          }),
          button(
            "Xóa trang dữ liệu",
            () =>
              onChange({
                ...recipe,
                entityPages: pages.filter((_, i) => i !== index),
              }),
            pages.length === 1 && !(recipe.pages || []).length,
          ),
        );
      }),
    );
  };
}
module.exports = {
  addDataPage,
  renameSchema,
  parsePageQuery,
  createEntityPageDesigner,
};
