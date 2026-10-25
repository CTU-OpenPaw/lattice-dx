// SPDX-License-Identifier: Apache-2.0
const {
  blankRecipe,
  companyOperationsRecipe,
  exampleRecipe,
  validateRecipe,
  fieldValue,
  sameConfiguration,
} = require("./system-model");
function createSystemScreens(client, React) {
  const { useState, useEffect } = React;
  const {
    h,
    box,
    inputStyle,
    labels,
    button,
    field,
    json,
    download,
    useSession,
    Frame,
  } = require("./system-shell").createSystemShell(client, React);
  const RuntimeBlocks = require("./runtime-blocks").createRuntimeBlocks(React, {
    h,
    box,
    button,
    json,
  });
  const WorkflowDesigner =
    require("./workflow-designer").createWorkflowDesigner(React, {
      h,
      box,
      button,
      field,
    });
  const EntityPageDesigner =
    require("./entity-page-designer").createEntityPageDesigner(React, {
      h,
      box,
      button,
      field,
    });
  const EntityPage = require("./entity-page").createEntityPage(React, {
    h,
    box,
    inputStyle,
    button,
    field,
    json,
  });
  function Studio() {
    const session = useSession(),
      { api, connection, act, busy, commands } = session;
    const [recipe, setRecipe] = useState(exampleRecipe),
      [draft, setDraft] = useState(null),
      [drafts, setDrafts] = useState({ items: [] }),
      [offset, setOffset] = useState(0),
      [plan, setPlan] = useState(null),
      [module, setModule] = useState(null),
      [audit, setAudit] = useState(null),
      [importText, setImportText] = useState("");
    const validation = validateRecipe(recipe);
    const blocked = busy || commands.uncertain;
    async function loadDrafts(next = 0) {
      const result = await api.studio("drafts", {
        query: { limit: "20", offset: String(next) },
      });
      setDrafts(result);
      setOffset(next);
    }
    useEffect(() => {
      if (connection?.connected) act(() => loadDrafts());
    }, [connection?.connected]);
    const edit = (change) => {
      setRecipe((current) => change(current));
      setPlan(null);
      setModule(null);
      setAudit(null);
    };
    const pageEdit = (index, change) =>
      edit((current) => ({
        ...current,
        pages: current.pages.map((p, i) => (i === index ? change(p) : p)),
      }));
    async function save() {
      const saved = await commands.execute("save", {
        ...(draft?.id === recipe.id ? { id: recipe.id } : {}),
        body: {
          recipe,
          ...(draft?.id === recipe.id
            ? { expectedRevision: draft.revision }
            : {}),
        },
      });
      setDraft(saved);
      await loadDrafts(offset);
    }
    async function check() {
      const v = validateRecipe(recipe);
      if (!v.valid) {
        throw Error(
          "Cấu hình chưa hợp lệ: " +
            v.issues[0] +
            " (Xem chi tiết bảng Kiểm tra cấu hình).",
        );
      }
      setModule(null);
      const result = await api.studio("plan", {
        body: { recipe },
        key: "plan-" + crypto.randomUUID(),
      });
      setPlan(result);
      if (result.installed) {
        if (result.installed.hash !== result.preview.hash)
          throw Error(
            "Phiên bản này đã cài với nội dung khác. Hãy tăng phiên bản trước khi triển khai thay đổi.",
          );
        setModule(result.installed);
      }
      session.report(
        "Cấu hình hợp lệ. " +
          (result.installed
            ? "Đã tải trạng thái triển khai."
            : "Sẵn sàng cài gói."),
      );
    }
    async function publish() {
      // Each workflow publication is independently durable; re-running resumes already published drafts.
      for (const definition of plan.manifest.bundle.definitions) {
        const current = await api.studio("draftDefinition", {
          id: definition.id,
        });
        await commands.execute("publish", {
          id: definition.id,
          body: { expectedRevision: current.revision },
        });
      }
      setModule(
        await api.studio("module", { id: recipe.id, version: recipe.version }),
      );
      session.report(
        "Các lược đồ đã xuất bản khi cài gói; các quy trình đã publish. Có thể bật hệ thống.",
      );
    }
    return h(
      Frame,
      { session, title: "LatticeDX Studio — tạo hệ thống từ cấu hình" },
      h(
        "section",
        { style: box },
        h("h2", null, "1. Chọn bản nháp hoặc bắt đầu mới"),
        button(
          "Tạo hệ thống trống",
          () => {
            setRecipe(blankRecipe());
            setDraft(null);
            setPlan(null);
            setModule(null);
            setAudit(null);
          },
          blocked,
        ),
        button(
          "Mẫu mới",
          () => {
            setRecipe(exampleRecipe());
            setDraft(null);
            setPlan(null);
            setModule(null);
            setAudit(null);
          },
          blocked,
        ),
        button(
          "Mẫu điều hành công ty",
          () => {
            setRecipe(companyOperationsRecipe());
            setDraft(null);
            setPlan(null);
            setModule(null);
            setAudit(null);
          },
          blocked,
        ),
        ...drafts.items.map((item) =>
          button(
            item.recipe.title + " · r" + item.revision,
            () =>
              act(async () => {
                const saved = await api.studio("draft", { id: item.id });
                setRecipe(saved.recipe);
                setDraft(saved);
                setPlan(null);
                setModule(null);
                setAudit(null);
              }),
            blocked,
          ),
        ),
        button(
          "Trang trước",
          () => act(() => loadDrafts(Math.max(0, offset - 20))),
          blocked || offset === 0,
        ),
        button(
          "Trang sau",
          () => act(() => loadDrafts(drafts.page.nextOffset)),
          blocked || !drafts.page?.hasMore,
        ),
      ),
      h(
        "fieldset",
        { disabled: blocked, style: box },
        h("legend", null, "2. Cấu hình hệ thống và module"),
        field("Mã hệ thống (chữ thường, tối đa 24 ký tự)", recipe.id, (v) =>
          edit((r) => ({ ...r, id: v })),
        ),
        field("Tên hệ thống", recipe.title, (v) =>
          edit((r) => ({ ...r, title: v })),
        ),
        field("Phiên bản cấu hình", recipe.version, (v) =>
          edit((r) => ({ ...r, version: v })),
        ),
        h(
          "p",
          null,
          "Mỗi module dùng mẫu: tạo nháp → gửi duyệt → phê duyệt và giao việc → hoàn thành. Mã vai trò phải tồn tại trên tài khoản Keycloak; Studio không tạo tài khoản hoặc vai trò SSO.",
        ),
        ...recipe.pages.map((page, index) =>
          h(
            "section",
            { key: index, style: box },
            h("h3", null, "Module " + (index + 1)),
            field("Mã module", page.id, (v) =>
              pageEdit(index, (p) => ({ ...p, id: v })),
            ),
            field("Tên module", page.title, (v) =>
              pageEdit(index, (p) => ({ ...p, title: v })),
            ),
            field("Vai trò người tạo", page.requesterRole, (v) =>
              pageEdit(index, (p) => ({ ...p, requesterRole: v })),
            ),
            field("Vai trò người duyệt", page.reviewerRole, (v) =>
              pageEdit(index, (p) => ({ ...p, reviewerRole: v })),
            ),
            field("Vai trò người thực hiện", page.handlerRole, (v) =>
              pageEdit(index, (p) => ({ ...p, handlerRole: v })),
            ),
            button(
              "Đưa module lên",
              () =>
                edit((r) => {
                  const pages = [...r.pages];
                  if (index > 0) {
                    const temp = pages[index - 1];
                    pages[index - 1] = pages[index];
                    pages[index] = temp;
                  }
                  return { ...r, pages };
                }),
              index === 0,
            ),
            button(
              "Đưa module xuống",
              () =>
                edit((r) => {
                  const pages = [...r.pages];
                  if (index < pages.length - 1) {
                    const temp = pages[index + 1];
                    pages[index + 1] = pages[index];
                    pages[index] = temp;
                  }
                  return { ...r, pages };
                }),
              index === recipe.pages.length - 1,
            ),
            ...page.fields.map((item, j) =>
              h(
                "div",
                { key: j },
                field("Tên trường", item.name, (v) =>
                  pageEdit(index, (p) => ({
                    ...p,
                    fields: p.fields.map((f, k) =>
                      k === j ? { ...f, name: v } : f,
                    ),
                  })),
                ),
                field("Nhãn hiển thị", item.label, (v) =>
                  pageEdit(index, (p) => ({
                    ...p,
                    fields: p.fields.map((f, k) =>
                      k === j ? { ...f, label: v } : f,
                    ),
                  })),
                ),
                h(
                  "select",
                  {
                    value: item.type,
                    onChange: (e) =>
                      pageEdit(index, (p) => ({
                        ...p,
                        fields: p.fields.map((f, k) =>
                          k === j ? { ...f, type: e.target.value } : f,
                        ),
                      })),
                  },
                  h("option", { value: "text" }, "Văn bản"),
                  h("option", { value: "positiveInteger" }, "Số nguyên dương"),
                ),
                h(
                  "label",
                  null,
                  h("input", {
                    type: "checkbox",
                    checked: item.required,
                    onChange: (e) =>
                      pageEdit(index, (p) => ({
                        ...p,
                        fields: p.fields.map((f, k) =>
                          k === j ? { ...f, required: e.target.checked } : f,
                        ),
                      })),
                  }),
                  "Bắt buộc",
                ),
                button(
                  "Xóa trường",
                  () =>
                    pageEdit(index, (p) => ({
                      ...p,
                      fields: p.fields.filter((_, k) => k !== j),
                    })),
                  page.fields.length === 1,
                ),
              ),
            ),
            button(
              "Thêm trường",
              () =>
                pageEdit(index, (p) => ({
                  ...p,
                  fields: [
                    ...p.fields,
                    {
                      name: "field" + (p.fields.length + 1),
                      label: "Trường mới",
                      type: "text",
                      required: true,
                    },
                  ],
                })),
              page.fields.length >= 12,
            ),
            button(
              "Xóa module",
              () =>
                edit((r) => ({
                  ...r,
                  pages: r.pages.filter((_, i) => i !== index),
                })),
              recipe.pages.length === 1 && !recipe.entityPages?.length,
            ),
            h(WorkflowDesigner, {
              page,
              onChange: (next) => pageEdit(index, () => next),
            }),
          ),
        ),
        button(
          "Thêm module",
          () =>
            edit((r) => {
              let num = r.pages.length + 1;
              while (r.pages.some((p) => p.id === "module-" + num)) num++;
              return {
                ...r,
                pages: [
                  ...r.pages,
                  {
                    id: "module-" + num,
                    title: "Module " + num,
                    requesterRole: "employee",
                    reviewerRole: "manager",
                    handlerRole: "operator",
                    blocks: ["create", "list", "inbox", "detail", "history"],
                    fields: [
                      {
                        name: "title",
                        label: "Tiêu đề",
                        type: "text",
                        required: true,
                      },
                    ],
                  },
                ],
              };
            }),
          recipe.pages.length >= 5,
        ),
        h(EntityPageDesigner, {
          recipe,
          onChange: (next) => edit(() => next),
        }),
        h(
          "div",
          {
            style: {
              ...box,
              borderLeft: validation.valid
                ? "4px solid #10b981"
                : "4px solid #f59e0b",
              background: validation.valid ? "#f0fdf4" : "#fffbeb",
              padding: "12px 16px",
              marginTop: "16px",
            },
          },
          h(
            "h3",
            { style: { marginTop: 0 } },
            "Kiểm tra cấu hình (Diagnostics)",
          ),
          validation.valid
            ? h(
                "p",
                { style: { color: "#065f46", fontWeight: "bold" } },
                "✔ Cấu hình hợp lệ: " +
                  recipe.id +
                  " v" +
                  recipe.version +
                  " (" +
                  recipe.pages.length +
                  " module quy trình, " +
                  (recipe.entityPages?.length || 0) +
                  " trang dữ liệu). Sẵn sàng xuất bản.",
              )
            : h(
                "div",
                null,
                h(
                  "p",
                  { style: { color: "#b45309", fontWeight: "bold" } },
                  "⚠ Các bước còn thiếu hoặc lỗi cần hoàn thiện trước khi xuất bản (" +
                    validation.issues.length +
                    " mục):",
                ),
                h(
                  "ul",
                  { style: { color: "#991b1b", paddingLeft: "20px" } },
                  ...validation.issues.map((issue, idx) =>
                    h("li", { key: idx }, issue),
                  ),
                ),
              ),
        ),
        h("hr"),
        button("Lưu bản nháp", () => act(save)),
        button("Kiểm tra cấu hình / tải trạng thái triển khai", () =>
          act(check),
        ),
        h(
          "p",
          null,
          draft
            ? "Bản nháp đã lưu: " + draft.id + " · revision " + draft.revision
            : "Bản nháp chưa được lưu.",
        ),
      ),
      plan &&
        h(
          "section",
          { style: box },
          h("h2", null, "3. Triển khai có kiểm soát"),
          json(plan.preview),
          h(
            "p",
            null,
            "Thứ tự: cài gói và xuất bản lược đồ ở trạng thái tắt → publish quy trình (nếu có) → bật sử dụng. Tải trạng thái lại nếu một bước bị gián đoạn. Cài lại gói có cùng nội dung là an toàn; thay đổi nội dung đã cài cần phiên bản mới. Lược đồ của gói mới cần mã mới.",
          ),
          button(
            "Cài gói cấu hình",
            () =>
              act(async () =>
                setModule(
                  await commands.execute("install", {
                    body: { manifest: plan.manifest },
                  }),
                ),
              ),
            blocked ||
              plan.preview.conflicts.length > 0 ||
              plan.preview.dependencyErrors.length > 0,
          ),
          plan.manifest.bundle.definitions.length > 0 &&
            button(
              "Publish các quy trình",
              () => act(publish),
              blocked || !module,
            ),
          module &&
            button(
              module.enabled ? "Tạm dừng tạo yêu cầu mới" : "Bật sử dụng",
              () =>
                act(async () =>
                  setModule(
                    await commands.execute("enable", {
                      id: module.id,
                      version: module.version,
                      body: {
                        expectedRevision: module.revision,
                        enabled: !module.enabled,
                      },
                    }),
                  ),
                ),
              blocked,
            ),
          module &&
            h(
              "a",
              { href: "/lattice/systems/" + module.id + "/" + module.version },
              "Mở hệ thống",
            ),
          module && json(module),
          module &&
            button(
              "Lịch sử quản trị",
              () =>
                act(async () =>
                  setAudit(
                    await api.studio("audit", {
                      id: module.id,
                      version: module.version,
                      query: { limit: "20", offset: "0" },
                    }),
                  ),
                ),
              busy,
            ),
          audit && json(audit),
        ),
      h(
        "section",
        { style: box },
        h("h2", null, "4. Xuất / nhập cấu hình để tái sử dụng"),
        button(
          "Tải gói cấu hình JSON",
          () =>
            download({
              id: recipe.id,
              format: "latticedx.system-package",
              formatVersion: 1,
              recipe,
              manifest: plan.manifest,
            }),
          blocked || !plan,
        ),
        h(
          "p",
          null,
          "Nhập gói recipe đã xuất. Đổi mã hệ thống và mã lược đồ để tạo hệ thống độc lập; đổi phiên bản và dùng mã lược đồ mới để phát triển bản mới. Gói không chứa tài khoản, mật khẩu hoặc dữ liệu hồ sơ.",
        ),
        h("textarea", {
          value: importText,
          onChange: (e) => setImportText(e.target.value),
          rows: 6,
          style: { width: "100%" },
          disabled: blocked,
          placeholder: "Dán JSON recipe tại đây",
        }),
        button(
          "Nhập vào bản nháp mới",
          () =>
            act(async () => {
              const packageValue = JSON.parse(importText);
              const imported =
                packageValue.format === "latticedx.system-package" &&
                packageValue.formatVersion === 1
                  ? packageValue.recipe
                  : packageValue;
              const compiled = await api.studio("plan", {
                body: { recipe: imported },
                key: "plan-" + crypto.randomUUID(),
              });
              if (
                packageValue.format === "latticedx.system-package" &&
                !sameConfiguration(packageValue.manifest, compiled.manifest)
              )
                throw Error(
                  "Gói cấu hình có recipe và manifest không khớp. Hãy xuất lại gói đã kiểm tra.",
                );
              setRecipe(imported);
              setDraft(null);
              setPlan(null);
              setModule(null);
              setAudit(null);
            }),
          blocked,
        ),
      ),
    );
  }
  function SystemRuntime() {
    const session = useSession(),
      { api, act, busy, connection, workflow } = session;
    const [catalog, setCatalog] = useState({ items: [] }),
      [catalogLoading, setCatalogLoading] = useState(false),
      [catalogError, setCatalogError] = useState(""),
      [catalogOffset, setCatalogOffset] = useState(0),
      [system, setSystem] = useState(null),
      [systemLoading, setSystemLoading] = useState(false),
      [systemError, setSystemError] = useState(""),
      [selectedPage, setSelectedPage] = useState(""),
      [runs, setRuns] = useState({ items: [] }),
      [runsLoading, setRunsLoading] = useState(false),
      [runsError, setRunsError] = useState(""),
      [offset, setOffset] = useState(0),
      [inbox, setInbox] = useState(false),
      [selected, setSelected] = useState(null),
      [history, setHistory] = useState(null),
      [sync, setSync] = useState(null),
      [values, setValues] = useState({}),
      [title, setTitle] = useState(""),
      [people, setPeople] = useState({ items: [] }),
      [peopleOffset, setPeopleOffset] = useState(0),
      [peopleSearch, setPeopleSearch] = useState("");
    const loc =
      typeof window !== "undefined"
        ? window.location
        : typeof location !== "undefined"
          ? location
          : { pathname: "", search: "" };
    const parts = loc.pathname.split("/"),
      id = parts[3],
      version = parts[4],
      pages = system
        ? [
            ...(system.presentation?.pages || []),
            ...(system.presentation?.entityPages || []),
          ]
        : [],
      page = pages.find((p) => p.id === selectedPage),
      dataPage = page?.schemaId ? page : null,
      definition = system?.definitions?.find((d) => d.id === page?.definitionId);
    const blocked = busy || workflow.uncertain;
    async function loadCatalog(next = 0) {
      setCatalogLoading(true);
      setCatalogError("");
      try {
        const res = await api.studio("apps", {
          query: { limit: "20", offset: String(next) },
        });
        setCatalog(res || { items: [] });
        setCatalogOffset(next);
      } catch (err) {
        setCatalogError(err.message || "Không thể tải danh sách hệ thống.");
        setCatalog({ items: [] });
      } finally {
        setCatalogLoading(false);
      }
    }
    async function loadRuns(next = 0) {
      if (!definition) return;
      setRunsLoading(true);
      setRunsError("");
      try {
        const res = await api.workflow(inbox ? "inbox" : "list", {
          query: {
            limit: "20",
            offset: String(next),
            definitionId: definition.id,
          },
        });
        setRuns(res || { items: [] });
        setOffset(next);
      } catch (err) {
        setRunsError(err.message || "Không thể tải danh sách hồ sơ.");
        setRuns({ items: [] });
      } finally {
        setRunsLoading(false);
      }
    }
    async function loadPeople(next = 0) {
      setPeople(
        await api.workflow("people", {
          query: {
            limit: "20",
            offset: String(next),
            role: definition.assignedReader.role,
            q: peopleSearch,
          },
        }),
      );
      setPeopleOffset(next);
    }
    useEffect(() => {
      if (connection?.connected)
        act(async () => {
          if (id) {
            setSystemLoading(true);
            setSystemError("");
            try {
              const result = await api.studio("app", { id, version });
              if (result.definitions?.length) await api.workflow("member");
              setSystem(result);
              setSelectedPage(
                result.presentation?.pages?.[0]?.id ||
                  result.presentation?.entityPages?.[0]?.id ||
                  "",
              );
            } catch (err) {
              setSystemError(
                err.message ||
                  "Tài khoản chưa được phân quyền hoặc hệ thống không tồn tại.",
              );
              setSystem(null);
            } finally {
              setSystemLoading(false);
            }
          } else await loadCatalog();
        });
    }, [connection?.connected, id, version]);
    useEffect(() => {
      setSelected(null);
      setHistory(null);
      setValues({});
      if (definition)
        act(async () => {
          await loadRuns();
          if (definition.canStart && connection?.capabilities?.directoryRead)
            await loadPeople();
        });
    }, [definition?.id, inbox]);
    async function open(run) {
      setSync(null);
      const current = await api.workflow("detail", { id: run.id });
      setSelected(current);
      setHistory(await api.workflow("history", { id: run.id }));
      setValues({});
    }
    function inputs(fields) {
      return Object.entries(fields).map(([name, type]) =>
        name === "handlerId"
          ? h(
              "label",
              { key: name, style: { display: "block", margin: "12px 0" } },
              page.fieldLabels[name],
              h(
                "select",
                {
                  required: true,
                  value: values[name] || "",
                  onChange: (e) =>
                    setValues((v) => ({ ...v, [name]: e.target.value })),
                  style: inputStyle,
                },
                h("option", { value: "" }, "Chọn người thực hiện"),
                ...people.items.map((person) =>
                  h(
                    "option",
                    { key: person.subject, value: person.subject },
                    person.displayName +
                      " · " +
                      (person.departmentId || "") +
                      " · " +
                      person.subject,
                  ),
                ),
              ),
            )
          : h(
              "span",
              { key: name },
              field(
                page.fieldLabels[name] || name,
                values[name] || "",
                (v) => setValues((values) => ({ ...values, [name]: v })),
                type === "positiveInteger" ? "number" : "text",
              ),
            ),
      );
    }
    function inputData(fields, optional = {}) {
      const result = {};
      for (const [name, type] of Object.entries({ ...fields, ...optional })) {
        const value = values[name];
        if (value !== undefined && value !== "")
          result[name] = fieldValue(type, value);
        else if (Object.hasOwn(fields, name))
          throw Error("Thiếu trường: " + (page.fieldLabels[name] || name));
      }
      return result;
    }
    return h(
      Frame,
      { session, title: system ? system.title : "Hệ thống đã xuất bản" },
      !id &&
        h(
          "section",
          { style: box },
          h("h2", null, "Danh mục hệ thống doanh nghiệp"),
          catalogLoading &&
            h("p", { role: "status" }, "⏳ Đang tải danh sách hệ thống…"),
          catalogError &&
            h(
              "p",
              { role: "alert", style: { color: "#dc2626" } },
              catalogError,
            ),
          !catalogLoading &&
            !catalogError &&
            catalog.items.map((item) =>
              h(
                "p",
                { key: item.id + item.version },
                h(
                  "a",
                  { href: "/lattice/systems/" + item.id + "/" + item.version },
                  item.title +
                    " · " +
                    item.version +
                    (item.enabled ? " · (Đang hoạt động)" : " · (Đã tạm dừng tạo mới)"),
                ),
              ),
            ),
          !catalogLoading &&
            !catalogError &&
            !catalog.items.length &&
            h(
              "p",
              { style: { color: "#64748b", fontStyle: "italic" } },
              "Chưa có hệ thống đã xuất bản phù hợp với vai trò của bạn.",
            ),
          button(
            "Trang trước",
            () => act(() => loadCatalog(Math.max(0, catalogOffset - 20))),
            busy || catalogLoading || catalogOffset === 0,
          ),
          button(
            "Trang sau",
            () => act(() => loadCatalog(catalog?.page?.nextOffset)),
            busy || catalogLoading || !catalog?.page?.hasMore,
          ),
        ),
      id &&
        !connection?.connected &&
        h(
          "p",
          { role: "alert" },
          "Vui lòng kết nối tài khoản nghiệp vụ để sử dụng hệ thống.",
        ),
      id &&
        systemLoading &&
        h(
          "p",
          { role: "status" },
          "⏳ Đang tải thông tin hệ thống và kiểm tra quyền…",
        ),
      id &&
        systemError &&
        h(
          "div",
          {
            role: "alert",
            style: {
              background: "#fee2e2",
              color: "#991b1b",
              padding: "12px 16px",
              borderRadius: 6,
              marginBottom: 16,
            },
          },
          h("strong", null, "Không thể truy cập hệ thống: "),
          systemError,
        ),
      system &&
        h(
          React.Fragment,
          null,
          h(
            "section",
            { style: box },
            h("h2", { style: { margin: "0 0 8px 0" } }, system.title),
            "Phiên bản " +
              system.version +
              " · ",
            h(
              "span",
              {
                style: {
                  background: system.enabled ? "#dcfce7" : "#fef3c7",
                  color: system.enabled ? "#15803d" : "#b45309",
                  padding: "2px 8px",
                  borderRadius: 4,
                  fontWeight: 600,
                },
              },
              system.enabled
                ? "Đang sử dụng"
                : "Đã tạm dừng tạo mới; hồ sơ cũ vẫn xử lý được",
            ),
            pages.length > 0 &&
              h(
                "nav",
                { style: { marginTop: 12 } },
                ...pages.map((p) =>
                  button(
                    p.title,
                    () => setSelectedPage(p.id),
                    busy || p.id === selectedPage,
                  ),
                ),
              ),
            !pages.length &&
              h(
                "p",
                { style: { color: "#64748b", marginTop: 8 } },
                "Hệ thống chưa cấu hình module / trang giao diện nào.",
              ),
          ),
          page &&
            !dataPage &&
            !definition &&
            h(
              "p",
              { role: "alert" },
              "Trang được chọn chưa được cấu hình module dữ liệu hoặc quy trình hợp lệ.",
            ),
          dataPage &&
            h(EntityPage, {
              key: dataPage.id,
              session,
              page: dataPage,
              schemas: system.schemas || [],
              enabled: system.enabled,
            }),
          definition &&
            h(
              RuntimeBlocks,
              {
                order: page.blocks,
                selected,
                history,
                sync,
                inbox,
                setInbox,
                busy,
                loadSync: () =>
                  act(async () =>
                    setSync(await api.workflow("sync", { id: selected.id })),
                  ),
              },
              definition.canStart &&
                system.enabled &&
                h(
                  "fieldset",
                  { style: box, disabled: blocked },
                  h("legend", null, "Tạo yêu cầu mới"),
                  field("Tiêu đề yêu cầu", title, setTitle),
                  inputs(definition.startFields),
                  inputs(definition.optionalStartFields || {}),
                  !connection?.capabilities?.directoryRead &&
                    h(
                      "p",
                      null,
                      "Tài khoản cần quyền danh bạ để chọn người thực hiện.",
                    ),
                  field(
                    "Tìm nhân viên theo tên",
                    peopleSearch,
                    setPeopleSearch,
                  ),
                  button("Tìm nhân viên", () => act(() => loadPeople())),
                  button(
                    "Nhân viên trước",
                    () => act(() => loadPeople(Math.max(0, peopleOffset - 20))),
                    peopleOffset === 0,
                  ),
                  button(
                    "Nhân viên sau",
                    () => act(() => loadPeople(people?.page?.nextOffset)),
                    !people?.page?.hasMore,
                  ),
                  button("Tạo bản nháp yêu cầu", () =>
                    act(async () => {
                      const run = await workflow.execute("create", {
                        definitionId: definition.id,
                        title,
                        input: inputData(
                          definition.startFields,
                          definition.optionalStartFields,
                        ),
                      });
                      setTitle("");
                      await loadRuns();
                      await open(run);
                    }),
                  ),
                ),
              h(
                "section",
                { style: box },
                h("h2", null, "Hồ sơ / công việc"),
                h(
                  "div",
                  { style: { display: "flex", gap: 8, marginBottom: 12 } },
                  button(
                    "Việc cần xử lý của tôi",
                    () => setInbox(true),
                    inbox,
                  ),
                  button(
                    "Tất cả hồ sơ",
                    () => setInbox(false),
                    !inbox,
                  ),
                ),
                button(
                  "Tải lại danh sách",
                  () => act(() => loadRuns(offset)),
                  busy || runsLoading,
                ),
                runsLoading &&
                  h("p", { role: "status" }, "⏳ Đang tải danh sách hồ sơ…"),
                runsError &&
                  h(
                    "p",
                    { role: "alert", style: { color: "#dc2626" } },
                    runsError,
                  ),
                !runsLoading &&
                  !runsError &&
                  (runs?.items || []).map((run) =>
                    h(
                      "p",
                      { key: run.id },
                      button(
                        run.title + " · " + (labels[run.state] || run.state),
                        () => act(() => open(run)),
                        busy,
                      ),
                    ),
                  ),
                !runsLoading &&
                  !runsError &&
                  !(runs?.items || []).length &&
                  h(
                    "p",
                    {
                      style: {
                        color: "#64748b",
                        fontStyle: "italic",
                        padding: "10px 0",
                      },
                    },
                    inbox
                      ? "Bạn không có công việc nào cần xử lý trong hộp việc."
                      : "Chưa có hồ sơ nào được tạo trong module này.",
                  ),
                button(
                  "Trang trước",
                  () => act(() => loadRuns(Math.max(0, offset - 20))),
                  busy || offset === 0,
                ),
                button(
                  "Trang sau",
                  () => act(() => loadRuns(runs?.page?.nextOffset)),
                  busy || !runs?.page?.hasMore,
                ),
              ),
              selected &&
                h(
                  "section",
                  { style: box },
                  h("h2", null, selected.title),
                  h(
                    "p",
                    null,
                    "Trạng thái: ",
                    h(
                      "span",
                      {
                        style: {
                          background: "#e0e7ff",
                          color: "#3730a3",
                          padding: "2px 8px",
                          borderRadius: 4,
                          fontWeight: 600,
                        },
                      },
                      labels[selected.state] || selected.state,
                    ),
                    " · phiên bản " + selected.version,
                  ),
                  h(
                    "small",
                    {
                      style: {
                        display: "block",
                        color: "#64748b",
                        marginBottom: 12,
                      },
                    },
                    "Mã hồ sơ: " + selected.id,
                  ),
                  h(
                    "dl",
                    {
                      style: {
                        background: "#f8fafc",
                        padding: 12,
                        borderRadius: 6,
                        border: "1px solid #e2e8f0",
                        display: "grid",
                        gridTemplateColumns: "auto 1fr",
                        gap: "8px 16px",
                      },
                    },
                    ...Object.entries(selected.data || {}).flatMap(
                      ([key, val]) => [
                        h(
                          "dt",
                          {
                            key: "k-" + key,
                            style: { fontWeight: 600, color: "#475569" },
                          },
                          page.fieldLabels?.[key] || key,
                        ),
                        h(
                          "dd",
                          { key: "v-" + key, style: { margin: 0 } },
                          String(val),
                        ),
                      ],
                    ),
                  ),
                  !selected.availableTransitions?.length &&
                    h(
                      "p",
                      {
                        style: {
                          color: "#64748b",
                          background: "#f1f5f9",
                          padding: "8px 12px",
                          borderRadius: 4,
                          marginTop: 12,
                        },
                      },
                      "Không có hành động chuyển bước nào khả dụng cho vai trò của bạn ở trạng thái hiện tại.",
                    ),
                  ...(selected.availableTransitions || []).map((transition) =>
                    h(
                      "fieldset",
                      { key: transition.id, disabled: blocked, style: box },
                      h("legend", null, labels[transition.id] || transition.id),
                      inputs(transition.fields),
                      button(labels[transition.id] || transition.id, () =>
                        act(async () => {
                          const run = await workflow.execute(
                            "transition",
                            {
                              action: transition.id,
                              expectedVersion: selected.version,
                              input: inputData(transition.fields),
                            },
                            selected.id,
                          );
                          await loadRuns(offset);
                          await open(run);
                        }),
                      ),
                    ),
                  ),
                ),
            ),
        ),
    );
  }
  return { Studio, SystemRuntime };
}
module.exports = { createSystemScreens };
