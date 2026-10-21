// SPDX-License-Identifier: Apache-2.0
function createOrganizationScreen(React, { h, box, button, field, json }) {
  const { useState, useEffect } = React;
  return function Organization({ session }) {
    const { api, capabilities, commands, act, busy } = session,
      [departments, setDepartments] = useState(null),
      [people, setPeople] = useState(null),
      [offset, setOffset] = useState(0),
      [peopleOffset, setPeopleOffset] = useState(0),
      [search, setSearch] = useState(""),
      [editing, setEditing] = useState({
        id: "",
        name: "",
        parentId: "",
        managerId: "",
      }),
      [history, setHistory] = useState(null),
      [historyId, setHistoryId] = useState(""),
      [historyOffset, setHistoryOffset] = useState(0);
    const manage = capabilities["organization.manage"]?.available,
      blocked = busy || commands.uncertain;
    async function load(next = 0) {
      setDepartments(
        await api.studio("departments", {
          query: { limit: "20", offset: String(next), q: search },
        }),
      );
      setOffset(next);
    }
    async function loadPeople(next = 0) {
      setPeople(
        await api.workflow("people", {
          query: { limit: "20", offset: String(next), q: search },
        }),
      );
      setPeopleOffset(next);
    }
    async function loadHistory(id, next = 0) {
      setHistory(
        await api.studio("departmentHistory", {
          id,
          query: { limit: "20", offset: String(next) },
        }),
      );
      setHistoryId(id);
      setHistoryOffset(next);
    }
    useEffect(() => {
      act(async () => {
        await load();
        await loadPeople();
      });
    }, []);
    const change = (key, value) =>
      setEditing((current) => ({ ...current, [key]: value }));
    return h(
      "section",
      { style: box },
      h("h2", null, "Phòng ban và danh bạ doanh nghiệp"),
      h(
        "p",
        null,
        "Cơ cấu thuộc engine. Tài khoản và vai trò đăng nhập do Keycloak quản lý; trang này không tự cấp quyền SSO.",
      ),
      field("Tìm phòng ban / nhân viên", search, setSearch),
      button(
        "Tìm / tải lại",
        () =>
          act(async () => {
            await load();
            await loadPeople();
          }),
        busy,
      ),
      h("h3", null, "Cơ cấu phòng ban"),
      h(
        "table",
        null,
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            ...["Phòng ban", "Cấp trên", "Quản lý", ""].map((label) =>
              h("th", { key: label }, label),
            ),
          ),
        ),
        h(
          "tbody",
          null,
          ...(departments?.items || []).map((department) =>
            h(
              "tr",
              { key: department.id },
              h(
                "td",
                null,
                department.name,
                h(
                  "small",
                  { style: { display: "block" } },
                  department.id + " · v" + department.version,
                ),
              ),
              h("td", null, department.parentId || "—"),
              h("td", null, department.managerId || "—"),
              h(
                "td",
                null,
                manage &&
                  button(
                    "Chỉnh sửa",
                    () => {
                      setEditing({
                        ...department,
                        parentId: department.parentId || "",
                        managerId: department.managerId || "",
                      });
                      setHistory(null);
                    },
                    blocked,
                  ),
                manage &&
                  button(
                    "Lịch sử",
                    () => act(() => loadHistory(department.id)),
                    busy,
                  ),
              ),
            ),
          ),
        ),
      ),
      button(
        "Phòng ban trước",
        () => act(() => load(Math.max(0, offset - 20))),
        busy || offset === 0,
      ),
      button(
        "Phòng ban sau",
        () => act(() => load(departments.page.nextOffset)),
        busy || !departments?.page?.hasMore,
      ),
      manage &&
        h(
          "fieldset",
          { style: box, disabled: blocked },
          h(
            "legend",
            null,
            editing.version
              ? "Sửa phòng ban · v" + editing.version
              : "Tạo phòng ban",
          ),
          h(
            "p",
            null,
            "ID quản lý lấy từ danh bạ bên dưới. Để trống nếu chưa phân công.",
          ),
          editing.version
            ? h("p", null, "Mã phòng ban: " + editing.id)
            : field("Mã phòng ban", editing.id, (value) => change("id", value)),
          field("Tên phòng ban", editing.name, (value) =>
            change("name", value),
          ),
          field("Mã phòng ban cấp trên", editing.parentId, (value) =>
            change("parentId", value),
          ),
          field("ID người quản lý", editing.managerId, (value) =>
            change("managerId", value),
          ),
          button("Lưu phòng ban", () =>
            act(async () => {
              if (!editing.id || !editing.name)
                throw Error("Cần mã và tên phòng ban.");
              const body = {
                name: editing.name,
                parentId: editing.parentId || null,
                managerId: editing.managerId || null,
              };
              await commands.execute(
                editing.version ? "updateDepartment" : "createDepartment",
                {
                  ...(editing.version ? { id: editing.id } : {}),
                  body: {
                    ...body,
                    ...(editing.version
                      ? { expectedVersion: editing.version }
                      : { id: editing.id }),
                  },
                },
              );
              setEditing({ id: "", name: "", parentId: "", managerId: "" });
              await load(offset);
              session.report("Đã lưu phòng ban.");
            }),
          ),
          button("Tạo mới", () =>
            setEditing({ id: "", name: "", parentId: "", managerId: "" }),
          ),
        ),
      history &&
        h(
          "section",
          { style: box },
          h("h3", null, "Lịch sử phòng ban " + historyId),
          json(history),
          button(
            "Lịch sử trước",
            () =>
              act(() =>
                loadHistory(historyId, Math.max(0, historyOffset - 20)),
              ),
            busy || historyOffset === 0,
          ),
          button(
            "Lịch sử sau",
            () => act(() => loadHistory(historyId, history.page.nextOffset)),
            busy || !history.page?.hasMore,
          ),
        ),
      h("h3", null, "Danh bạ và quyền hiện có"),
      h(
        "table",
        null,
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            ...["Tên / tài khoản", "Phòng ban", "Vai trò", ""].map((label) =>
              h("th", { key: label }, label),
            ),
          ),
        ),
        h(
          "tbody",
          null,
          ...(people?.items || []).map((person) =>
            h(
              "tr",
              { key: person.subject },
              h(
                "td",
                null,
                person.displayName,
                h(
                  "small",
                  { style: { display: "block", overflowWrap: "anywhere" } },
                  person.subject,
                ),
              ),
              h("td", null, person.departmentId || "—"),
              h("td", null, person.roles.join(", ")),
              h(
                "td",
                null,
                manage &&
                  button(
                    "Chọn làm quản lý",
                    () => change("managerId", person.subject),
                    blocked,
                  ),
              ),
            ),
          ),
        ),
      ),
      button(
        "Nhân viên trước",
        () => act(() => loadPeople(Math.max(0, peopleOffset - 20))),
        busy || peopleOffset === 0,
      ),
      button(
        "Nhân viên sau",
        () => act(() => loadPeople(people.page.nextOffset)),
        busy || !people?.page?.hasMore,
      ),
    );
  };
}
module.exports = { createOrganizationScreen };
