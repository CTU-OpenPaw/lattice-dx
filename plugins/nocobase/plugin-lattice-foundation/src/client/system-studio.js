// SPDX-License-Identifier: Apache-2.0
const {
  exampleRecipe,
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
      session.report("Đã publish các quy trình. Có thể bật hệ thống.");
    }
    return h(
      Frame,
      { session, title: "LatticeDX Studio — tạo hệ thống từ cấu hình" },
      h(
        "section",
        { style: box },
        h("h2", null, "1. Chọn bản nháp hoặc bắt đầu mới"),
        button(
          "Mẫu mới",
          () => {
            setRecipe(exampleRecipe());
            setDraft(null);
            setPlan(null);
            setModule(null);
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
              recipe.pages.length === 1,
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
            edit((r) => ({
              ...r,
              pages: [
                ...r.pages,
                {
                  ...exampleRecipe().pages[0],
                  id: "module-" + (r.pages.length + 1),
                },
              ],
            })),
          recipe.pages.length >= 5,
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
            "Thứ tự: cài gói ở trạng thái tắt → publish quy trình → bật sử dụng. Tải trạng thái lại nếu một bước bị gián đoạn. Cài lại gói có cùng nội dung là an toàn; thay đổi nội dung đã cài cần phiên bản mới.",
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
          "Nhập gói recipe đã xuất. Đổi mã hệ thống để tạo hệ thống độc lập; đổi phiên bản để phát triển bản mới. Gói không chứa tài khoản, mật khẩu hoặc dữ liệu hồ sơ.",
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
      [catalogOffset, setCatalogOffset] = useState(0),
      [system, setSystem] = useState(null),
      [selectedPage, setSelectedPage] = useState(""),
      [runs, setRuns] = useState({ items: [] }),
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
    const parts = location.pathname.split("/"),
      id = parts[3],
      version = parts[4],
      page = system?.presentation.pages.find((p) => p.id === selectedPage),
      definition = system?.definitions.find((d) => d.id === page?.definitionId);
    const blocked = busy || workflow.uncertain;
    async function loadCatalog(next = 0) {
      setCatalog(
        await api.studio("apps", {
          query: { limit: "20", offset: String(next) },
        }),
      );
      setCatalogOffset(next);
    }
    async function loadRuns(next = 0) {
      if (!definition) return;
      setRuns(
        await api.workflow(inbox ? "inbox" : "list", {
          query: {
            limit: "20",
            offset: String(next),
            definitionId: definition.id,
          },
        }),
      );
      setOffset(next);
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
          await api.workflow("member");
          if (id) {
            const result = await api.studio("app", { id, version });
            setSystem(result);
            setSelectedPage(result.presentation.pages[0]?.id || "");
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
          ...catalog.items.map((item) =>
            h(
              "p",
              { key: item.id + item.version },
              h(
                "a",
                { href: "/lattice/systems/" + item.id + "/" + item.version },
                item.title +
                  " · " +
                  item.version +
                  (item.enabled ? "" : " · Đã tạm dừng tạo mới"),
              ),
            ),
          ),
          !catalog.items.length &&
            h(
              "p",
              null,
              "Chưa có hệ thống đã xuất bản phù hợp với vai trò của bạn.",
            ),
          button(
            "Trang trước",
            () => act(() => loadCatalog(Math.max(0, catalogOffset - 20))),
            busy || catalogOffset === 0,
          ),
          button(
            "Trang sau",
            () => act(() => loadCatalog(catalog.page.nextOffset)),
            busy || !catalog.page?.hasMore,
          ),
        ),
      system &&
        h(
          React.Fragment,
          null,
          h(
            "section",
            { style: box },
            "Phiên bản " +
              system.version +
              " · " +
              (system.enabled
                ? "Đang sử dụng"
                : "Đã tạm dừng tạo mới; hồ sơ cũ vẫn xử lý được"),
            h(
              "nav",
              null,
              ...system.presentation.pages.map((p) =>
                button(
                  p.title,
                  () => setSelectedPage(p.id),
                  busy || p.id === selectedPage,
                ),
              ),
            ),
          ),
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
                  !connection.capabilities?.directoryRead &&
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
                    () => act(() => loadPeople(people.page.nextOffset)),
                    !people.page?.hasMore,
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
                button("Tải lại", () => act(() => loadRuns(offset)), busy),
                ...runs.items.map((run) =>
                  h(
                    "p",
                    { key: run.id },
                    button(
                      run.title + " · " + run.state,
                      () => act(() => open(run)),
                      busy,
                    ),
                  ),
                ),
                !runs.items.length && h("p", null, "Không có hồ sơ phù hợp."),
                button(
                  "Trang trước",
                  () => act(() => loadRuns(Math.max(0, offset - 20))),
                  busy || offset === 0,
                ),
                button(
                  "Trang sau",
                  () => act(() => loadRuns(runs.page.nextOffset)),
                  busy || !runs.page?.hasMore,
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
                    "Trạng thái: " +
                      selected.state +
                      " · phiên bản " +
                      selected.version,
                  ),
                  json(selected.data),
                  ...selected.availableTransitions.map((transition) =>
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
