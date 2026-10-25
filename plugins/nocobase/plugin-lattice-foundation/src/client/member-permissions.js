// SPDX-License-Identifier: Apache-2.0

function createMemberPermissions(React, shell) {
  const { useState, useEffect } = React;
  const { h, box, button, field, json } = shell;

  return function MemberPermissions({ session, systemId: initialSystemId }) {
    const { api, capabilities, commands, act, busy } = session;
    const [systems, setSystems] = useState({ items: [] });
    const [selectedSystemId, setSelectedSystemId] = useState(initialSystemId || "");
    const [selectedSystem, setSelectedSystem] = useState(null);
    const [departments, setDepartments] = useState({ items: [] });
    const [people, setPeople] = useState({ items: [] });
    const [members, setMembers] = useState(null);
    const [apiReady, setApiReady] = useState(true);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [search, setSearch] = useState("");
    const [deptFilter, setDeptFilter] = useState("");
    const [editingMember, setEditingMember] = useState(null);
    const [selectedRoles, setSelectedRoles] = useState([]);
    const [newSubject, setNewSubject] = useState("");

    const canManage = capabilities?.["organization.manage"]?.available ?? true;
    const blocked = busy || commands?.uncertain;

    // Load available systems
    async function loadSystems() {
      try {
        const appsResult = await api.studio("apps", {
          query: { limit: "50", offset: "0" },
        });
        setSystems(appsResult || { items: [] });
        if (!selectedSystemId && appsResult?.items?.length) {
          setSelectedSystemId(appsResult.items[0].id);
        }
      } catch (err) {
        // Safe fallback if apps call fails
        setSystems({ items: [] });
      }
    }

    // Load departments and directory people
    async function loadDirectory() {
      try {
        const deptResult = await api.studio("departments", {
          query: { limit: "100", offset: "0" },
        });
        setDepartments(deptResult || { items: [] });
      } catch (err) {
        setDepartments({ items: [] });
      }

      try {
        const peopleResult = await api.workflow("people", {
          query: { limit: "100", offset: "0" },
        });
        setPeople(peopleResult || { items: [] });
      } catch (err) {
        setPeople({ items: [] });
      }
    }

    // Load system details and members
    async function loadSystemMembers(sysId) {
      if (!sysId) {
        setSelectedSystem(null);
        setMembers(null);
        return;
      }
      setLoading(true);
      setError("");
      try {
        // Load detailed system manifest to extract defined roles
        const appDetail = await api.studio("app", { id: sysId });
        setSelectedSystem(appDetail);

        // Attempt to load system members from API
        try {
          const membersResult = await api.studio("systemMembers", {
            id: sysId,
            query: { limit: "50", offset: "0" },
          });
          setMembers(membersResult);
          setApiReady(true);
        } catch (apiErr) {
          // If backend API is not yet registered by Duy, report clearly
          setApiReady(false);
          setMembers(null);
        }
      } catch (err) {
        setError("Không thể tải thông tin hệ thống: " + (err.message || String(err)));
      } finally {
        setLoading(false);
      }
    }

    useEffect(() => {
      act(async () => {
        await loadSystems();
        await loadDirectory();
      });
    }, []);

    useEffect(() => {
      if (selectedSystemId) {
        act(async () => {
          await loadSystemMembers(selectedSystemId);
        });
      }
    }, [selectedSystemId]);

    // Extract defined roles from system definitions
    const systemRoles = React.useMemo(() => {
      if (!selectedSystem?.definitions?.length) {
        return ["employee", "manager", "operator"];
      }
      const roles = new Set();
      selectedSystem.definitions.forEach((def) => {
        if (def.startRole) roles.add(def.startRole);
        if (def.readerRoles) def.readerRoles.forEach((r) => roles.add(r));
        if (def.assignedReader?.role) roles.add(def.assignedReader.role);
        if (def.transitions) {
          def.transitions.forEach((t) => {
            if (t.role) roles.add(t.role);
          });
        }
      });
      return Array.from(roles);
    }, [selectedSystem]);

    // Role display descriptions
    const roleLabels = {
      employee: "Nhân viên (Khởi tạo yêu cầu)",
      manager: "Quản lý (Phê duyệt và giao việc)",
      operator: "Điều phối viên / Thực hiện",
      "procurement:manager": "Quản lý Mua sắm",
      "logistics:warehouse": "Quản lý Kho vận",
    };

    // Filter people for the selection dropdown
    const availablePeople = (people?.items || []).filter((p) => {
      if (deptFilter && p.departmentId !== deptFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        const matchName = (p.displayName || "").toLowerCase().includes(q);
        const matchSub = (p.subject || "").toLowerCase().includes(q);
        if (!matchName && !matchSub) return false;
      }
      return true;
    });

    // Grant or update member roles
    async function handleGrant() {
      if (!newSubject) {
        setError("Vui lòng chọn nhân viên cần cấp quyền.");
        return;
      }
      if (!selectedRoles.length) {
        setError("Vui lòng chọn ít nhất một vai trò trong hệ thống.");
        return;
      }
      setError("");
      try {
        await commands.execute("grantSystemMember", {
          id: selectedSystemId,
          body: {
            subject: newSubject,
            roles: selectedRoles,
          },
        });
        session.report("Đã cấp quyền thành công cho nhân viên.");
        setNewSubject("");
        setSelectedRoles([]);
        setEditingMember(null);
        await loadSystemMembers(selectedSystemId);
      } catch (err) {
        setError("Cấp quyền thất bại: " + (err.message || String(err)));
      }
    }

    // Revoke member roles
    async function handleRevoke(subject) {
      setError("");
      try {
        await commands.execute("revokeSystemMember", {
          id: selectedSystemId,
          body: { subject },
        });
        session.report("Đã thu hồi quyền sử dụng hệ thống.");
        await loadSystemMembers(selectedSystemId);
      } catch (err) {
        setError("Thu hồi quyền thất bại: " + (err.message || String(err)));
      }
    }

    return h(
      "section",
      { style: box },
      h("h2", null, "Quản trị Thành viên & Phân quyền Hệ thống"),
      h(
        "p",
        null,
        "Chọn người được dùng hệ thống và vai trò tương ứng. Quyền hạn được kiểm tra và chứng thực bởi API máy chủ.",
      ),

      // Notice when API is pending backend integration
      !apiReady &&
        h(
          "div",
          {
            role: "alert",
            style: {
              background: "#eff6ff",
              borderLeft: "4px solid #3b82f6",
              padding: "10px 14px",
              marginBottom: 16,
              color: "#1e40af",
            },
          },
          h(
            "strong",
            null,
            "ℹ Trạng thái tích hợp API:",
          ),
          " Giao diện phân quyền đã sẵn sàng. Đang chờ Duy bổ sung API máy chủ (GET/POST /v1/systems/:systemId/members). Dưới đây là danh bạ nhân sự hiện có để cấu hình.",
        ),

      // System Selector
      h(
        "div",
        { style: { marginBottom: 16 } },
        h("strong", null, "Hệ thống cần phân quyền: "),
        h(
          "select",
          {
            value: selectedSystemId,
            onChange: (e) => setSelectedSystemId(e.target.value),
            style: { padding: "6px 12px", marginLeft: 8, borderRadius: 4 },
          },
          ...systems.items.map((sys) =>
            h(
              "option",
              { key: sys.id, value: sys.id },
              sys.title + " (" + sys.id + " · v" + sys.version + ")",
            ),
          ),
        ),
        button("Tải lại danh sách", () => act(() => loadSystemMembers(selectedSystemId)), busy),
      ),

      // System Roles Summary
      selectedSystem &&
        h(
          "div",
          {
            style: {
              background: "#f8fafc",
              padding: "10px 14px",
              borderRadius: 6,
              marginBottom: 16,
              border: "1px solid #e2e8f0",
            },
          },
          h(
            "p",
            { style: { margin: "0 0 6px 0", fontWeight: 600 } },
            "Các vai trò được định nghĩa trong hệ thống " +
              (selectedSystem.title || selectedSystemId) +
              ":",
          ),
          h(
            "div",
            { style: { display: "flex", gap: 10, flexWrap: "wrap" } },
            ...systemRoles.map((role) =>
              h(
                "span",
                {
                  key: role,
                  style: {
                    background: "#e0e7ff",
                    color: "#3730a3",
                    padding: "3px 8px",
                    borderRadius: 4,
                    fontSize: 13,
                  },
                },
                roleLabels[role] || role,
              ),
            ),
          ),
        ),

      // Error message
      error &&
        h(
          "p",
          {
            role: "alert",
            style: {
              color: "#dc2626",
              background: "#fee2e2",
              padding: "8px 12px",
              borderRadius: 4,
            },
          },
          error,
        ),

      // Grant / Edit Permission Section
      canManage &&
        h(
          "fieldset",
          {
            style: { ...box, background: "#fafafa", borderColor: "#cbd5e1" },
            disabled: blocked,
          },
          h(
            "legend",
            { style: { fontWeight: 600, padding: "0 6px" } },
            editingMember ? "Sửa vai trò thành viên" : "Cấp quyền truy cập hệ thống",
          ),
          h(
            "p",
            null,
            "Chọn nhân viên từ danh bạ doanh nghiệp và gán các vai trò tương ứng trong hệ thống:",
          ),

          // Filters for choosing person
          h(
            "div",
            { style: { display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" } },
            field("Tìm kiếm nhân viên", search, setSearch),
            h(
              "label",
              { style: { display: "inline-flex", flexDirection: "column", gap: 4 } },
              "Phòng ban",
              h(
                "select",
                {
                  value: deptFilter,
                  onChange: (e) => setDeptFilter(e.target.value),
                  style: { padding: 8, borderRadius: 4, width: 220 },
                },
                h("option", { value: "" }, "-- Tất cả phòng ban --"),
                ...departments.items.map((d) =>
                  h("option", { key: d.id, value: d.id }, d.name),
                ),
              ),
            ),
          ),

          // Person select dropdown
          h(
            "div",
            { style: { marginTop: 10, marginBottom: 12 } },
            h("strong", null, "Chọn người dùng: "),
            h(
              "select",
              {
                value: newSubject,
                onChange: (e) => setNewSubject(e.target.value),
                style: { padding: "8px 12px", minWidth: 300, borderRadius: 4 },
                disabled: !!editingMember,
              },
              h("option", { value: "" }, "-- Chọn nhân viên --"),
              ...availablePeople.map((p) =>
                h(
                  "option",
                  { key: p.subject, value: p.subject },
                  p.displayName + " (" + (p.departmentId || "Chưa gắn phòng") + ")",
                ),
              ),
            ),
          ),

          // Roles checkboxes
          h(
            "div",
            { style: { margin: "12px 0" } },
            h("strong", null, "Chọn vai trò được cấp trong hệ thống:"),
            h(
              "div",
              { style: { marginTop: 8 } },
              ...systemRoles.map((role) =>
                h(
                  "label",
                  {
                    key: role,
                    style: { display: "inline-block", marginRight: 16, cursor: "pointer" },
                  },
                  h("input", {
                    type: "checkbox",
                    checked: selectedRoles.includes(role),
                    onChange: (e) => {
                      if (e.target.checked) {
                        setSelectedRoles([...selectedRoles, role]);
                      } else {
                        setSelectedRoles(selectedRoles.filter((r) => r !== role));
                      }
                    },
                  }),
                  " " + (roleLabels[role] || role),
                ),
              ),
            ),
          ),

          button(
            editingMember ? "Lưu thay đổi vai trò" : "Cấp quyền cho nhân viên",
            () => act(handleGrant),
            blocked || !newSubject || !selectedRoles.length,
          ),
          editingMember &&
            button("Hủy chỉnh sửa", () => {
              setEditingMember(null);
              setNewSubject("");
              setSelectedRoles([]);
            }),
        ),

      // Members List Table
      h("h3", null, "Danh sách người dùng đã được phân quyền"),
      loading
        ? h("p", null, "⏳ Đang tải dữ liệu...")
        : members?.items?.length
          ? h(
              "table",
              { style: { width: "100%", borderCollapse: "collapse", marginTop: 8 } },
              h(
                "thead",
                null,
                h(
                  "tr",
                  { style: { background: "#f1f5f9", textAlign: "left" } },
                  ...["Họ và tên / Tài khoản", "Phòng ban", "Vai trò trong hệ thống", "Trạng thái", ""].map(
                    (th) => h("th", { key: th, style: { padding: "8px 12px" } }, th),
                  ),
                ),
              ),
              h(
                "tbody",
                null,
                ...members.items.map((m) =>
                  h(
                    "tr",
                    { key: m.subject, style: { borderBottom: "1px solid #e2e8f0" } },
                    h(
                      "td",
                      { style: { padding: "8px 12px" } },
                      h("strong", null, m.displayName || m.subject),
                      h(
                        "small",
                        { style: { display: "block", color: "#64748b" } },
                        m.subject,
                      ),
                    ),
                    h("td", { style: { padding: "8px 12px" } }, m.departmentName || m.departmentId || "—"),
                    h(
                      "td",
                      { style: { padding: "8px 12px" } },
                      (m.roles || []).map((r) => roleLabels[r] || r).join(", "),
                    ),
                    h(
                      "td",
                      { style: { padding: "8px 12px" } },
                      h(
                        "span",
                        {
                          style: {
                            background: "#dcfce7",
                            color: "#15803d",
                            padding: "2px 6px",
                            borderRadius: 4,
                            fontSize: 12,
                          },
                        },
                        "Được phép",
                      ),
                    ),
                    h(
                      "td",
                      { style: { padding: "8px 12px", textAlign: "right" } },
                      canManage &&
                        button(
                          "Sửa vai trò",
                          () => {
                            setEditingMember(m);
                            setNewSubject(m.subject);
                            setSelectedRoles(m.roles || []);
                          },
                          blocked,
                        ),
                      canManage &&
                        button(
                          "Thu hồi",
                          () => act(() => handleRevoke(m.subject)),
                          blocked,
                        ),
                    ),
                  ),
                ),
              ),
            )
          : h(
              "div",
              {
                style: {
                  padding: "16px 20px",
                  background: "#f8fafc",
                  borderRadius: 6,
                  border: "1px dashed #cbd5e1",
                  color: "#64748b",
                },
              },
              h(
                "p",
                { style: { margin: 0, fontWeight: 500 } },
                "Chưa có tài khoản nào được chỉ định quyền riêng trong hệ thống này.",
              ),
              h(
                "p",
                { style: { margin: "4px 0 0 0", fontSize: 13 } },
                "Mặc định: Tất cả nhân viên có vai trò tương ứng (được cấp từ Keycloak/SSO) sẽ truy cập theo đúng phạm vi module đã cấu hình.",
              ),
            ),
    );
  };
}

module.exports = { createMemberPermissions };
