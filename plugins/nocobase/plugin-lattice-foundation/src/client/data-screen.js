// SPDX-License-Identifier: Apache-2.0
const { attributesFromForm } = require("./console-model");
const { sameConfiguration } = require("./system-model");
function createDataScreen(React, { h, box, button, field, json, inputStyle }) {
  const { useState, useEffect } = React,
    types = ["text", "boolean", "integer", "decimal", "date", "enum"];
  function TypedFields({ fields, values, setValues, disabled }) {
    return h(
      "fieldset",
      { disabled, style: { border: 0, padding: 0 } },
      ...Object.entries(fields).map(([name, definition]) => {
        const label = name + (definition.required ? " *" : ""),
          change = (value) =>
            setValues((current) => ({ ...current, [name]: value }));
        if (definition.type === "boolean" || definition.type === "enum")
          return h(
            "label",
            {
              key: name,
              style: {
                display: "inline-flex",
                flexDirection: "column",
                margin: "8px 18px 8px 0",
              },
            },
            label,
            h(
              "select",
              {
                style: inputStyle,
                value: values[name] === undefined ? "" : String(values[name]),
                onChange: (event) =>
                  change(
                    definition.type === "boolean"
                      ? event.target.value === ""
                        ? undefined
                        : event.target.value === "true"
                      : event.target.value,
                  ),
              },
              h("option", { value: "" }, "Chưa chọn"),
              ...(definition.type === "boolean"
                ? [
                    ["true", "Đúng"],
                    ["false", "Sai"],
                  ]
                : definition.choices.map((value) => [value, value])
              ).map(([value, label]) =>
                h("option", { key: value, value }, label),
              ),
            ),
          );
        return h(
          "span",
          { key: name },
          field(
            label,
            values[name] ?? "",
            change,
            definition.type === "date"
              ? "date"
              : definition.type === "integer"
                ? "number"
                : "text",
          ),
        );
      }),
    );
  }
  function SchemaEditor({ session, initial, onSaved }) {
    const { commands, act, busy } = session,
      [schema, setSchema] = useState(initial),
      blocked = busy || commands.uncertain;
    const update = (key, value) =>
      setSchema((current) => ({ ...current, [key]: value }));
    const rows = Object.entries(schema.fields),
      relations = Object.entries(schema.relations || {});
    const changeField = (index, key, value) => {
      const entries = Object.entries(schema.fields);
      const [name, definition] = entries[index];
      entries[index] =
        key === "name"
          ? [value, definition]
          : [name, { ...definition, [key]: value }];
      if (new Set(entries.map(([name]) => name)).size !== entries.length) {
        session.report("Tên trường bị trùng.");
        return;
      }
      setSchema({ ...schema, fields: Object.fromEntries(entries) });
    };
    async function save() {
      const definition = {
        id: schema.id,
        title: schema.title,
        fields: schema.fields,
        relations: schema.relations || {},
      };
      const saved = await commands.execute(
        schema.revision ? "saveSchema" : "createSchema",
        {
          ...(schema.revision ? { id: schema.id } : {}),
          body: schema.revision
            ? {
                expectedRevision: schema.revision,
                title: definition.title,
                fields: definition.fields,
                relations: definition.relations,
              }
            : definition,
        },
      );
      setSchema(saved);
      await onSaved(saved);
      session.report("Đã lưu cấu trúc dữ liệu.");
    }
    return h(
      "fieldset",
      { style: box, disabled: blocked },
      h(
        "legend",
        null,
        schema.revision
          ? "Cấu trúc · revision " + schema.revision
          : "Thiết kế cấu trúc mới",
      ),
      schema.revision
        ? h("p", null, "Mã: " + schema.id)
        : field("Mã cấu trúc", schema.id, (value) => update("id", value)),
      field("Tên cấu trúc", schema.title, (value) => update("title", value)),
      ...rows.map(([name, definition], index) =>
        h(
          "div",
          { key: index, style: box },
          field("Tên trường", name, (value) =>
            changeField(index, "name", value),
          ),
          h(
            "select",
            {
              value: definition.type,
              onChange: (event) => {
                const next = {
                  type: event.target.value,
                  required: definition.required || false,
                  ...(event.target.value === "enum"
                    ? { choices: ["option"] }
                    : {}),
                };
                setSchema((current) => ({
                  ...current,
                  fields: { ...current.fields, [name]: next },
                }));
              },
            },
            ...types.map((type) =>
              h("option", { key: type, value: type }, type),
            ),
          ),
          h(
            "label",
            null,
            h("input", {
              type: "checkbox",
              checked: !!definition.required,
              onChange: (event) =>
                changeField(index, "required", event.target.checked),
            }),
            " Bắt buộc",
          ),
          definition.type === "enum" &&
            field(
              "Giá trị lựa chọn (ngăn bằng dấu phẩy)",
              definition.choices.join(","),
              (value) =>
                changeField(
                  index,
                  "choices",
                  value.split(",").map((item) => item.trim()),
                ),
            ),
          button("Xóa trường", () =>
            update(
              "fields",
              Object.fromEntries(rows.filter((_, i) => i !== index)),
            ),
          ),
        ),
      ),
      button(
        "Thêm trường",
        () => {
          let index = rows.length + 1;
          while (Object.hasOwn(schema.fields, "field" + index)) index++;
          update("fields", {
            ...schema.fields,
            ["field" + index]: { type: "text", required: false },
          });
        },
        rows.length >= 50,
      ),
      h("h3", null, "Quan hệ tới cấu trúc khác"),
      ...relations.map(([name, relation], index) =>
        h(
          "div",
          { key: index },
          field("Tên quan hệ", name, (value) => {
            const entries = [...relations];
            entries[index] = [value, relation];
            if (new Set(entries.map(([name]) => name)).size !== entries.length) {
              session.report("Tên quan hệ bị trùng.");
              return;
            }
            update("relations", Object.fromEntries(entries));
          }),
          field("Mã cấu trúc đích", relation.targetSchemaId, (value) =>
            update("relations", {
              ...schema.relations,
              [name]: { targetSchemaId: value },
            }),
          ),
          button("Xóa quan hệ", () =>
            update(
              "relations",
              Object.fromEntries(relations.filter((_, i) => i !== index)),
            ),
          ),
        ),
      ),
      button(
        "Thêm quan hệ",
        () => {
          let index = relations.length + 1;
          while (Object.hasOwn(schema.relations || {}, "relation" + index))
            index++;
          update("relations", {
            ...schema.relations,
            ["relation" + index]: { targetSchemaId: "" },
          });
        },
        relations.length >= 20,
      ),
      h("hr"),
      button("Lưu cấu trúc", () => act(save)),
      schema.revision &&
        button(
          "Publish cấu trúc đã lưu",
          () =>
            act(async () => {
              await commands.execute("publishSchema", {
                id: schema.id,
                body: { expectedRevision: schema.revision },
              });
              await onSaved(
                await session.api.studio("schema", { id: schema.id }),
              );
              session.report("Đã publish cấu trúc.");
            }),
          !sameConfiguration(schema, initial),
        ),
      h(
        "p",
        null,
        "Publish dùng bản đã lưu; hãy lưu mọi thay đổi trước khi publish. Các hồ sơ cũ vẫn giữ phiên bản cấu trúc đã tạo ra chúng.",
      ),
    );
  }
  return function Data({ session }) {
    const { api, capabilities, commands, act, busy } = session,
      [schemas, setSchemas] = useState(null),
      [schemaOffset, setSchemaOffset] = useState(0),
      [editor, setEditor] = useState(null),
      [editorKey, setEditorKey] = useState(0),
      [schemaId, setSchemaId] = useState(
        new URLSearchParams(location.search).get("schema") || "",
      ),
      [schemaVersion, setSchemaVersion] = useState(
        new URLSearchParams(location.search).get("version") || "1",
      ),
      [publication, setPublication] = useState(null),
      [records, setRecords] = useState(null),
      [offset, setOffset] = useState(0),
      [search, setSearch] = useState(""),
      [entity, setEntity] = useState(null),
      [entitySchema, setEntitySchema] = useState(null),
      [values, setValues] = useState({}),
      [title, setTitle] = useState(""),
      [history, setHistory] = useState(null),
      [historyOffset, setHistoryOffset] = useState(0),
      [shares, setShares] = useState(null),
      [shareOffset, setShareOffset] = useState(0),
      [shareKind, setShareKind] = useState("person"),
      [principal, setPrincipal] = useState(""),
      [permission, setPermission] = useState("read");
    const design = capabilities["entities.design"]?.available,
      read = capabilities["entities.read"]?.available,
      write = capabilities["entities.write"]?.available,
      canShare = capabilities["entities.share"]?.available,
      blocked = busy || commands.uncertain;
    async function loadSchemas(next = 0) {
      setSchemas(
        await api.studio("schemas", {
          query: { limit: "12", offset: String(next), q: search },
        }),
      );
      setSchemaOffset(next);
    }
    async function loadRecords(next = 0, filter = schemaId) {
      if (!read) return;
      setRecords(
        await api.entity("list", {
          query: {
            limit: "20",
            offset: String(next),
            q: search,
            ...(filter ? { schemaId: filter } : {}),
          },
        }),
      );
      setOffset(next);
    }
    async function published(id = schemaId, version = schemaVersion) {
      const result = await api.studio("publishedSchema", {
        id,
        version: Number(version),
      });
      setSchemaId(id);
      setSchemaVersion(String(result.version));
      setPublication(result);
      setEntity(null);
      setValues({});
      setTitle("");
      await loadRecords(0, id);
    }
    useEffect(() => {
      act(async () => {
        if (design) await loadSchemas();
        if (read) {
          if (schemaId) await published();
          else await loadRecords();
        }
      });
    }, []);
    async function saved(schema) {
      setEditor(schema);
      setEditorKey((key) => key + 1);
      await loadSchemas(schemaOffset);
    }
    async function open(row) {
      setHistory(null);
      setShares(null);
      const result = await api.entity("detail", { id: row.id }),
        definition = await api.studio("publishedSchema", {
          id: result.schemaId,
          version: result.schemaVersion,
        });
      setEntity(result);
      setEntitySchema(definition);
      setValues(result.attributes);
      setTitle(result.title);
      setHistory(
        await api.studio("entityHistory", {
          id: result.id,
          query: { limit: "20", offset: "0" },
        }),
      );
      setHistoryOffset(0);
    }
    const displaySchema = entity ? entitySchema : publication;
    return h(
      "section",
      null,
      design &&
        h(
          "section",
          { style: box },
          h("h2", null, "Thiết kế dữ liệu"),
          h(
            "p",
            null,
            "Định nghĩa một lần, engine kiểm tra kiểu và sinh API. Chọn phiên bản đã publish để mở biểu mẫu nhập liệu.",
          ),
          field("Tìm cấu trúc", search, setSearch),
          button("Tìm / tải lại", () => act(() => loadSchemas()), busy),
          button(
            "Cấu trúc mới",
            () => {
              setEditor({
                id: "",
                title: "",
                fields: { description: { type: "text", required: true } },
                relations: {},
              });
              setEditorKey((key) => key + 1);
            },
            blocked,
          ),
          ...(schemas?.items || []).map((schema) =>
            h(
              "article",
              { key: schema.id, style: box },
              h("strong", null, schema.title),
              h(
                "p",
                null,
                schema.id +
                  " · r" +
                  schema.revision +
                  " · đã publish v" +
                  schema.publishedVersion,
              ),
              button(
                "Thiết kế",
                () => {
                  setEditor(schema);
                  setEditorKey((key) => key + 1);
                },
                blocked,
              ),
              schema.publishedVersion > 0 &&
                read &&
                button(
                  "Mở dữ liệu",
                  () =>
                    act(() => published(schema.id, schema.publishedVersion)),
                  busy,
                ),
              schema.publishedVersion > 0 &&
                h(
                  "a",
                  {
                    href:
                      "/lattice/console?section=data&schema=" +
                      schema.id +
                      "&version=" +
                      schema.publishedVersion,
                  },
                  "Liên kết nhập liệu",
                ),
            ),
          ),
          button(
            "Cấu trúc trước",
            () => act(() => loadSchemas(Math.max(0, schemaOffset - 12))),
            busy || schemaOffset === 0,
          ),
          button(
            "Cấu trúc sau",
            () => act(() => loadSchemas(schemas.page.nextOffset)),
            busy || !schemas?.page?.hasMore,
          ),
          editor &&
            h(SchemaEditor, {
              key: editorKey,
              session,
              initial: editor,
              onSaved: saved,
            }),
        ),
      read &&
        h(
          "section",
          { style: box },
          h("h2", null, "Dữ liệu nghiệp vụ"),
          field("Mã cấu trúc", schemaId, setSchemaId),
          field(
            "Phiên bản đã publish",
            schemaVersion,
            setSchemaVersion,
            "number",
          ),
          button("Mở cấu trúc và dữ liệu", () => act(() => published()), busy),
          button(
            "Tất cả dữ liệu được chia sẻ / sở hữu",
            () =>
              act(async () => {
                setSchemaId("");
                setPublication(null);
                setEntity(null);
                await loadRecords(0, "");
              }),
            busy,
          ),
          h(
            "p",
            null,
            "Danh sách theo quyền đọc thực tế. Liên kết cấu trúc không cấp thêm quyền đọc hồ sơ.",
          ),
          field("Tìm hồ sơ", search, setSearch),
          button("Lọc hồ sơ", () => act(() => loadRecords()), busy),
          ...(records?.items || []).map((row) =>
            h(
              "article",
              {
                key: row.id,
                style: { padding: 12, borderBottom: "1px solid #dde5ee" },
              },
              button(row.title, () => act(() => open(row)), busy),
              h(
                "span",
                null,
                row.schemaId +
                  " · cấu trúc v" +
                  row.schemaVersion +
                  " · hồ sơ v" +
                  row.version +
                  (row.archivedAt ? " · Đã lưu trữ" : ""),
              ),
            ),
          ),
          button(
            "Hồ sơ trước",
            () => act(() => loadRecords(Math.max(0, offset - 20))),
            busy || offset === 0,
          ),
          button(
            "Hồ sơ sau",
            () => act(() => loadRecords(records.page.nextOffset)),
            busy || !records?.page?.hasMore,
          ),
          displaySchema &&
            h(
              "section",
              { style: box },
              h(
                "h3",
                null,
                entity
                  ? "Chi tiết · " + entity.id
                  : "Tạo hồ sơ · " + displaySchema.title,
              ),
              h(
                "fieldset",
                {
                  disabled: blocked || !write || !!entity?.archivedAt,
                  style: { border: 0, padding: 0 },
                },
                field("Tiêu đề hồ sơ", title, setTitle),
              ),
              h(TypedFields, {
                fields: displaySchema.fields,
                values,
                setValues,
                disabled: blocked || !write || !!entity?.archivedAt,
              }),
              write &&
                !entity?.archivedAt &&
                button(
                  entity ? "Lưu thay đổi" : "Tạo hồ sơ",
                  () =>
                    act(async () => {
                      const attributes = attributesFromForm(
                        displaySchema.fields,
                        values,
                      );
                      const result = await commands.execute(
                        entity ? "entityUpdate" : "entityCreate",
                        {
                          ...(entity ? { id: entity.id } : {}),
                          body: entity
                            ? {
                                expectedVersion: entity.version,
                                title,
                                attributes,
                              }
                            : {
                                schemaId: displaySchema.id,
                                schemaVersion: displaySchema.version,
                                title,
                                attributes,
                              },
                        },
                      );
                      await loadRecords(offset);
                      await open(result);
                      session.report("Đã lưu hồ sơ.");
                    }),
                  blocked,
                ),
              entity &&
                button(
                  "Tạo hồ sơ khác",
                  () => {
                    setEntity(null);
                    setPublication(entitySchema);
                    setValues({});
                    setTitle("");
                    setHistory(null);
                    setShares(null);
                  },
                  blocked,
                ),
              entity &&
                h(
                  React.Fragment,
                  null,
                  h(
                    "p",
                    null,
                    "Chủ sở hữu: " +
                      entity.ownerId +
                      " · Phiên bản " +
                      entity.version,
                  ),
                  h("h3", null, "Lịch sử thay đổi"),
                  history && json(history),
                  button(
                    "Lịch sử trước",
                    () =>
                      act(async () => {
                        const next = Math.max(0, historyOffset - 20);
                        setHistory(
                          await api.studio("entityHistory", {
                            id: entity.id,
                            query: { limit: "20", offset: String(next) },
                          }),
                        );
                        setHistoryOffset(next);
                      }),
                    busy || historyOffset === 0,
                  ),
                  button(
                    "Lịch sử sau",
                    () =>
                      act(async () => {
                        const next = history.page.nextOffset;
                        setHistory(
                          await api.studio("entityHistory", {
                            id: entity.id,
                            query: { limit: "20", offset: String(next) },
                          }),
                        );
                        setHistoryOffset(next);
                      }),
                    busy || !history?.page?.hasMore,
                  ),
                  canShare &&
                    h(
                      "fieldset",
                      { disabled: blocked, style: box },
                      h("legend", null, "Chia sẻ quyền trên hồ sơ này"),
                      h(
                        "p",
                        null,
                        "Chỉ chủ sở hữu hoặc người đủ quyền mới chia sẻ được. ID lấy từ danh bạ/phòng ban; backend kiểm tra đối tượng và đơn vị.",
                      ),
                      h(
                        "select",
                        {
                          value: shareKind,
                          onChange: (event) => setShareKind(event.target.value),
                        },
                        h("option", { value: "person" }, "Nhân viên"),
                        h("option", { value: "department" }, "Phòng ban"),
                      ),
                      field(
                        "ID người / phòng ban nhận quyền",
                        principal,
                        setPrincipal,
                      ),
                      h(
                        "select",
                        {
                          value: permission,
                          onChange: (event) =>
                            setPermission(event.target.value),
                        },
                        h("option", { value: "read" }, "Đọc"),
                        h("option", { value: "edit" }, "Sửa"),
                      ),
                      button("Cấp quyền", () =>
                        act(async () => {
                          const result = await commands.execute("share", {
                            id: entity.id,
                            body: {
                              expectedVersion: entity.version,
                              principal: { kind: shareKind, id: principal },
                              permission,
                            },
                          });
                          setEntity(result);
                          session.report("Đã cập nhật chia sẻ hồ sơ.");
                        }),
                      ),
                      button("Xem quyền hiện tại", () =>
                        act(async () => {
                          setShares(
                            await api.studio("shares", {
                              id: entity.id,
                              query: { limit: "20", offset: "0" },
                            }),
                          );
                          setShareOffset(0);
                        }),
                      ),
                      shares && json(shares),
                      button(
                        "Quyền trước",
                        () =>
                          act(async () => {
                            const next = Math.max(0, shareOffset - 20);
                            setShares(
                              await api.studio("shares", {
                                id: entity.id,
                                query: { limit: "20", offset: String(next) },
                              }),
                            );
                            setShareOffset(next);
                          }),
                        !shares || shareOffset === 0,
                      ),
                      button(
                        "Quyền sau",
                        () =>
                          act(async () => {
                            const next = shares.page.nextOffset;
                            setShares(
                              await api.studio("shares", {
                                id: entity.id,
                                query: { limit: "20", offset: String(next) },
                              }),
                            );
                            setShareOffset(next);
                          }),
                        !shares?.page?.hasMore,
                      ),
                    ),
                ),
            ),
        ),
    );
  };
}
module.exports = { createDataScreen };
