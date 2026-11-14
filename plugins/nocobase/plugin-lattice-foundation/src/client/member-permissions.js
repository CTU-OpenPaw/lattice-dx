/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */

function createMemberPermissions(React, shell) {
  const { useState, useEffect, useMemo } = React;
  const useRef = React.useRef || ((init) => { const [r] = useState({ current: init }); return r; });
  const { h, box, button, field } = shell;

  const RESERVED_PLATFORM_ROLES = new Set([
    "workflow:design",
    "data:design",
    "workflow:start",
    "data:read",
    "data:write",
    "data:share",
    "directory:read",
    "directory:manage",
    "platform:operate",
    "tasks:read",
    "tasks:assign",
    "records:write",
  ]);

  function formatError(err) {
    const status = err?.status || err?.response?.status;
    if (status === 403) {
      return "Tài khoản không có quyền thực hiện thao tác này (yêu cầu quyền quản trị: workflow:design và data:design).";
    }
    if (status === 404) {
      return "Không tìm thấy hệ thống hoặc phiên bản yêu cầu.";
    }
    if (status === 409) {
      return "Dữ liệu phân quyền đã thay đổi hoặc xung đột phiên bản (CAS). Hãy tải lại trước khi thử lại.";
    }
    if (status === 503) {
      return "Dịch vụ phân quyền hiện không khả dụng. Vui lòng thử lại sau.";
    }
    if (status === 400) {
      return "Yêu cầu không hợp lệ hoặc vai trò không thuộc định nghĩa hệ thống.";
    }
    return err?.message || "Đã xảy ra lỗi khi thực hiện thao tác.";
  }

  return function MemberPermissions({
    session,
    systemId: initialSystemId,
    systemVersion: initialSystemVersion,
  }) {
    const { api, capabilities, commands, act, busy, connection } = session;
    const [selectedSystemId, setSelectedSystemId] = useState(initialSystemId || "");
    const [selectedSystemVersion, setSelectedSystemVersion] = useState(initialSystemVersion || "");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [search, setSearch] = useState("");
    const [deptFilter, setDeptFilter] = useState("");
    const [principalType, setPrincipalType] = useState("person");
    const [newPrincipalId, setNewPrincipalId] = useState("");
    const [selectedRoles, setSelectedRoles] = useState([]);
    const [editingMember, setEditingMember] = useState(null);

    // Stable scope tagging calculated directly at render
    const isConnected = Boolean(connection?.connected !== false);
    const currentSubject = connection?.identity?.subject || "";
    const currentOrgId = connection?.identity?.organizationId || "";
    const currentOrgScope = `${isConnected ? "1" : "0"}:${currentSubject}:${currentOrgId}`;
    const currentSystemScope = `${currentOrgScope}:${selectedSystemId}:${selectedSystemVersion}`;

    const currentOrgScopeRef = useRef(currentOrgScope);
    currentOrgScopeRef.current = currentOrgScope;

    const currentSystemScopeRef = useRef(currentSystemScope);
    currentSystemScopeRef.current = currentSystemScope;

    const reqSeqRef = useRef(0);
    const lastCommandRef = useRef(null);
    const [pendingMutation, setPendingMutation] = useState(null);

    // Scoped state stores: records are explicitly tagged with their loading scope
    const [systemsState, setSystemsState] = useState({ scope: "", items: [] });
    const [departmentsState, setDepartmentsState] = useState({ scope: "", items: [] });
    const [peopleState, setPeopleState] = useState({ scope: "", items: [] });
    const [systemDataState, setSystemDataState] = useState({
      scope: "",
      system: null,
      members: null,
      policy: null,
      myAccess: null,
    });

    // Visible data gated strictly by matching active scope
    const systems = systemsState.scope === currentOrgScope ? systemsState : { items: [] };
    const departments = departmentsState.scope === currentOrgScope ? departmentsState : { items: [] };
    const people = peopleState.scope === currentOrgScope ? peopleState : { items: [] };

    const isSystemScopeCurrent = systemDataState.scope === currentSystemScope;
    const selectedSystem = isSystemScopeCurrent ? systemDataState.system : null;
    const members = isSystemScopeCurrent ? systemDataState.members : null;
    const policy = isSystemScopeCurrent ? systemDataState.policy : null;
    const myAccess = isSystemScopeCurrent ? systemDataState.myAccess : null;

    const hasAdminRoles = Boolean(
      connection?.identity?.roles?.includes("workflow:design") &&
      connection?.identity?.roles?.includes("data:design")
    );
    const canManage = hasAdminRoles || Boolean(
      (capabilities?.["workflow.design"]?.available || capabilities?.["workflow:design"]?.available) &&
      (capabilities?.["entities.design"]?.available || capabilities?.["data.design"]?.available || capabilities?.["data:design"]?.available || capabilities?.["modules.preflight"]?.available)
    );
    const blocked = busy || Boolean(commands?.uncertain) || Boolean(pendingMutation);

    async function loadSystems() {
      const scopeAtCall = currentOrgScope;
      try {
        const appsResult = canManage
          ? await api.studio("adminSystems", { query: { limit: "50", offset: "0" } })
          : await api.studio("apps", { query: { limit: "50", offset: "0" } });

        if (currentOrgScopeRef.current !== scopeAtCall) return;
        const items = appsResult?.items || [];
        setSystemsState({ scope: scopeAtCall, items });
        if ((!selectedSystemId || !selectedSystemVersion) && items.length > 0) {
          const matched = initialSystemId
            ? items.find((sys) => sys.id === initialSystemId && (!initialSystemVersion || sys.version === initialSystemVersion)) || items[0]
            : items[0];
          setSelectedSystemId(matched.id);
          setSelectedSystemVersion(matched.version);
        }
      } catch (err) {
        if (currentOrgScopeRef.current === scopeAtCall) {
          setSystemsState({ scope: scopeAtCall, items: [] });
          setError("Không thể tải danh sách hệ thống: " + formatError(err));
        }
      }
    }

    async function loadDirectory() {
      const scopeAtCall = currentOrgScope;
      try {
        const deptResult = await api.studio("departments", {
          query: { limit: "100", offset: "0" },
        });
        if (currentOrgScopeRef.current === scopeAtCall) {
          setDepartmentsState({ scope: scopeAtCall, items: deptResult?.items || [] });
        }
      } catch {
        if (currentOrgScopeRef.current === scopeAtCall) {
          setDepartmentsState({ scope: scopeAtCall, items: [] });
        }
      }

      try {
        const peopleResult = await api.workflow("people", {
          query: { limit: "100", offset: "0" },
        });
        if (currentOrgScopeRef.current === scopeAtCall) {
          setPeopleState({ scope: scopeAtCall, items: peopleResult?.items || [] });
        }
      } catch {
        if (currentOrgScopeRef.current === scopeAtCall) {
          setPeopleState({ scope: scopeAtCall, items: [] });
        }
      }
    }

    async function loadSystemData(sysId, sysVer) {
      if (!sysId || !sysVer) {
        setSystemDataState({ scope: "", system: null, members: null, policy: null, myAccess: null });
        return;
      }
      const scopeAtCall = `${currentOrgScope}:${sysId}:${sysVer}`;
      const thisSeq = ++reqSeqRef.current;
      setLoading(true);
      setError("");
      try {
        const appDetail = canManage
          ? await api.studio("adminSystem", { id: sysId, version: sysVer })
          : await api.studio("app", { id: sysId, version: sysVer });

        if (currentSystemScopeRef.current !== scopeAtCall || reqSeqRef.current !== thisSeq) return;

        let membersResult = null;
        try {
          membersResult = await api.studio("members", {
            id: sysId,
            version: sysVer,
            query: { limit: "50", offset: "0" },
          });
        } catch (mErr) {
          if (currentSystemScopeRef.current === scopeAtCall && reqSeqRef.current === thisSeq) {
            setError("Không thể tải danh sách thành viên: " + formatError(mErr));
          }
        }
        if (currentSystemScopeRef.current !== scopeAtCall || reqSeqRef.current !== thisSeq) return;

        let policyResult = null;
        try {
          policyResult = await api.studio("policy", { id: sysId, version: sysVer });
        } catch {
          // Absent policy is legacy
        }
        if (currentSystemScopeRef.current !== scopeAtCall || reqSeqRef.current !== thisSeq) return;

        let myAccessResult = null;
        try {
          myAccessResult = await api.studio("myAccess", { id: sysId, version: sysVer });
        } catch {
          // Absent access or 404 for ungranted admin
        }
        if (currentSystemScopeRef.current !== scopeAtCall || reqSeqRef.current !== thisSeq) return;

        setSystemDataState({
          scope: scopeAtCall,
          system: appDetail,
          members: membersResult,
          policy: policyResult,
          myAccess: myAccessResult,
        });
      } catch (err) {
        if (currentSystemScopeRef.current === scopeAtCall && reqSeqRef.current === thisSeq) {
          setError("Không thể tải thông tin hệ thống: " + formatError(err));
          setSystemDataState({ scope: scopeAtCall, system: null, members: null, policy: null, myAccess: null });
        }
      } finally {
        if (currentSystemScopeRef.current === scopeAtCall && reqSeqRef.current === thisSeq) {
          setLoading(false);
        }
      }
    }

    useEffect(() => {
      act(async () => {
        await loadSystems();
        await loadDirectory();
      });
    }, [currentOrgScope]);

    useEffect(() => {
      reqSeqRef.current += 1;
      setEditingMember(null);
      setSelectedRoles([]);
      setNewPrincipalId("");
      setError("");

      if (selectedSystemId && selectedSystemVersion) {
        act(async () => {
          await loadSystemData(selectedSystemId, selectedSystemVersion);
        });
      } else {
        setSystemDataState({ scope: "", system: null, members: null, policy: null, myAccess: null });
      }
      return () => {
        reqSeqRef.current += 1;
      };
    }, [currentSystemScope]);

    const hasUnpublishedDefinitions = Boolean(
      selectedSystem?.definitions?.some((d) => d.published === false)
    );

    const systemRoles = useMemo(() => {
      if (Array.isArray(selectedSystem?.permittedBusinessRoles)) {
        return selectedSystem.permittedBusinessRoles.filter(
          (r) =>
            typeof r === "string" &&
            !RESERVED_PLATFORM_ROLES.has(r) &&
            !r.startsWith("platform:") &&
            r !== "admin"
        );
      }
      if (!selectedSystem?.definitions?.length) {
        return [];
      }
      const roles = new Set();
      selectedSystem.definitions.forEach((def) => {
        if (def.published === false) return;
        if (def.startRole) roles.add(def.startRole);
        if (def.readerRoles) def.readerRoles.forEach((r) => roles.add(r));
        if (def.assignedReader?.role) roles.add(def.assignedReader.role);
        if (def.transitions) {
          def.transitions.forEach((t) => {
            if (t.role) roles.add(t.role);
          });
        }
      });
      return Array.from(roles).filter(
        (r) =>
          typeof r === "string" &&
          !RESERVED_PLATFORM_ROLES.has(r) &&
          !r.startsWith("platform:") &&
          r !== "admin"
      );
    }, [selectedSystem]);

    const roleLabels = {
      employee: "Nhân viên (Khởi tạo yêu cầu)",
      manager: "Quản lý (Phê duyệt và giao việc)",
      operator: "Điều phối viên / Thực hiện",
      "procurement:manager": "Quản lý Mua sắm",
      "logistics:warehouse": "Quản lý Kho vận",
    };

    const deptMap = useMemo(() => {
      const map = {};
      (departments?.items || []).forEach((d) => {
        map[d.id] = d.name;
      });
      return map;
    }, [departments]);

    const personMap = useMemo(() => {
      const map = {};
      (people?.items || []).forEach((p) => {
        map[p.subject] = p.displayName || p.subject;
      });
      return map;
    }, [people]);

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

    async function handleGrant() {
      if (!newPrincipalId) {
        setError(principalType === "department" ? "Vui lòng chọn phòng ban." : "Vui lòng chọn nhân viên.");
        return;
      }
      setError("");
      const targetId = selectedSystemId;
      const targetVer = selectedSystemVersion;
      const targetScope = currentSystemScope;
      const mutationSeq = ++reqSeqRef.current;
      const cmdInfo = {
        op: "grantMember",
        targetScope,
        targetId,
        targetVer,
        payload: {
          id: targetId,
          version: targetVer,
          body: {
            principalType,
            principalId: newPrincipalId,
            roles: selectedRoles,
          },
        },
      };
      lastCommandRef.current = cmdInfo;
      setPendingMutation(cmdInfo);
      try {
        await commands.execute("grantMember", cmdInfo.payload);
        setPendingMutation(null);
        if (currentSystemScopeRef.current !== targetScope || reqSeqRef.current !== mutationSeq) return;
        session.report("Đã cấp quyền thành công cho thành viên.");
        setNewPrincipalId("");
        setSelectedRoles([]);
        setEditingMember(null);
        await loadSystemData(targetId, targetVer);
      } catch (err) {
        setPendingMutation(null);
        if (currentSystemScopeRef.current === targetScope && reqSeqRef.current === mutationSeq) {
          setError("Cấp quyền thất bại: " + formatError(err));
        }
      }
    }

    async function handleUpdate() {
      if (!editingMember) return;
      setError("");
      const targetId = selectedSystemId;
      const targetVer = selectedSystemVersion;
      const targetScope = currentSystemScope;
      const mutationSeq = ++reqSeqRef.current;
      const cmdInfo = {
        op: "updateMember",
        targetScope,
        targetId,
        targetVer,
        payload: {
          id: targetId,
          version: targetVer,
          principalType: editingMember.principalType,
          principalId: editingMember.principalId,
          body: {
            expectedRevision: editingMember.revision,
            roles: selectedRoles,
          },
        },
      };
      lastCommandRef.current = cmdInfo;
      setPendingMutation(cmdInfo);
      try {
        await commands.execute("updateMember", cmdInfo.payload);
        setPendingMutation(null);
        if (currentSystemScopeRef.current !== targetScope || reqSeqRef.current !== mutationSeq) return;
        session.report("Đã cập nhật vai trò thành viên thành công.");
        setEditingMember(null);
        setSelectedRoles([]);
        setNewPrincipalId("");
        await loadSystemData(targetId, targetVer);
      } catch (err) {
        setPendingMutation(null);
        if (currentSystemScopeRef.current === targetScope && reqSeqRef.current === mutationSeq) {
          setError("Cập nhật vai trò thất bại: " + formatError(err));
        }
      }
    }

    async function handleRevoke(member) {
      setError("");
      const targetId = selectedSystemId;
      const targetVer = selectedSystemVersion;
      const targetScope = currentSystemScope;
      const mutationSeq = ++reqSeqRef.current;
      const cmdInfo = {
        op: "revokeMember",
        targetScope,
        targetId,
        targetVer,
        payload: {
          id: targetId,
          version: targetVer,
          principalType: member.principalType,
          principalId: member.principalId,
          body: {
            expectedRevision: member.revision,
          },
        },
      };
      lastCommandRef.current = cmdInfo;
      setPendingMutation(cmdInfo);
      try {
        await commands.execute("revokeMember", cmdInfo.payload);
        setPendingMutation(null);
        if (currentSystemScopeRef.current !== targetScope || reqSeqRef.current !== mutationSeq) return;
        session.report("Đã thu hồi quyền sử dụng hệ thống.");
        await loadSystemData(targetId, targetVer);
      } catch (err) {
        setPendingMutation(null);
        if (currentSystemScopeRef.current === targetScope && reqSeqRef.current === mutationSeq) {
          setError("Thu hồi quyền thất bại: " + formatError(err));
        }
      }
    }

    async function handleActivatePolicy() {
      setError("");
      const targetId = selectedSystemId;
      const targetVer = selectedSystemVersion;
      const targetScope = currentSystemScope;
      const mutationSeq = ++reqSeqRef.current;
      const cmdInfo = {
        op: "activatePolicy",
        targetScope,
        targetId,
        targetVer,
        payload: {
          id: targetId,
          version: targetVer,
          body: {
            expectedRevision: policy?.revision ?? 0,
          },
        },
      };
      lastCommandRef.current = cmdInfo;
      setPendingMutation(cmdInfo);
      try {
        await commands.execute("activatePolicy", cmdInfo.payload);
        setPendingMutation(null);
        if (currentSystemScopeRef.current !== targetScope || reqSeqRef.current !== mutationSeq) return;
        session.report("Đã kích hoạt thực thi chính sách phân quyền cho phiên bản hệ thống.");
        await loadSystemData(targetId, targetVer);
      } catch (err) {
        setPendingMutation(null);
        if (currentSystemScopeRef.current === targetScope && reqSeqRef.current === mutationSeq) {
          setError("Kích hoạt chính sách thất bại: " + formatError(err));
        }
      }
    }

    async function handleRetryUncertain() {
      if (!lastCommandRef.current) return;
      const cmd = lastCommandRef.current;
      setError("");
      setPendingMutation(cmd);
      try {
        await commands.execute(cmd.op, cmd.payload);
        setPendingMutation(null);
        if (currentSystemScopeRef.current === cmd.targetScope) {
          session.report("Đã thực hiện lại lệnh thành công.");
          await loadSystemData(cmd.targetId, cmd.targetVer);
        }
      } catch (err) {
        setPendingMutation(null);
        if (currentSystemScopeRef.current === cmd.targetScope) {
          setError("Thử lại lệnh thất bại: " + formatError(err));
        }
      }
    }

    return h(
      "section",
      { style: box },
      h("h2", null, "Quản trị Thành viên & Phân quyền Hệ thống"),
      h(
        "p",
        null,
        "Chọn người dùng hoặc phòng ban được dùng hệ thống và vai trò tương ứng. Quyền hạn thuộc từng phiên bản hệ thống bất biến.",
      ),

      // Uncertain Write Warning Banner & Honest Original-Target Retry
      commands?.uncertain &&
        lastCommandRef.current &&
        h(
          "div",
          {
            style: {
              background: "#fef2f2",
              border: "1px solid #fecaca",
              padding: "10px 14px",
              borderRadius: 6,
              marginBottom: 16,
              color: "#991b1b",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 8,
            },
          },
          h(
            "div",
            null,
            h("strong", null, "⚠️ Lệnh chưa xác định kết quả (Uncertain write): "),
            `Thao tác '${lastCommandRef.current.op}' trên hệ thống '${lastCommandRef.current.targetId}' (v${lastCommandRef.current.targetVer}) bị gián đoạn. Lựa chọn hệ thống đang được khóa để bảo vệ dữ liệu.`,
          ),
          button(
            "Thử lại lệnh cho mục tiêu ban đầu",
            () => act(handleRetryUncertain),
            busy,
          ),
        ),

      // System & Version Selector
      h(
        "div",
        { style: { marginBottom: 16, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } },
        h("strong", null, "Hệ thống cần phân quyền: "),
        h(
          "select",
          {
            value: selectedSystemId && selectedSystemVersion ? `${selectedSystemId}:${selectedSystemVersion}` : "",
            disabled: blocked,
            onChange: (e) => {
              if (blocked) return;
              const val = e.target.value;
              if (val) {
                const [sysId, sysVer] = val.split(":");
                setSelectedSystemId(sysId);
                setSelectedSystemVersion(sysVer);
              } else {
                setSelectedSystemId("");
                setSelectedSystemVersion("");
              }
            },
            style: { padding: "6px 12px", borderRadius: 4 },
          },
          ...systems.items.map((sys) =>
            h(
              "option",
              { key: `${sys.id}:${sys.version}`, value: `${sys.id}:${sys.version}` },
              `${sys.title || sys.id} (${sys.id} · v${sys.version})`,
            ),
          ),
        ),
        button(
          "Tải lại danh sách",
          () => act(() => loadSystemData(selectedSystemId, selectedSystemVersion)),
          blocked || !selectedSystemId,
        ),
      ),

      // Warning for unpublished definitions
      selectedSystem &&
        hasUnpublishedDefinitions &&
        h(
          "div",
          {
            style: {
              background: "#fffbeb",
              border: "1px solid #fde68a",
              padding: "10px 14px",
              borderRadius: 6,
              marginBottom: 16,
              color: "#92400e",
              fontSize: 13,
            },
          },
          "⚠️ Cảnh báo: Hệ thống có quy trình chưa xuất bản (unpublished). Các vai trò trong quy trình chưa xuất bản sẽ không được áp dụng vào quyền hạn.",
        ),

      // Effective access summary for current user (myAccess)
      myAccess &&
        h(
          "div",
          {
            style: {
              background: "#f0fdf4",
              border: "1px solid #bbf7d0",
              padding: "10px 14px",
              borderRadius: 6,
              marginBottom: 16,
              color: "#166534",
            },
          },
          h(
            "p",
            { style: { margin: "0 0 4px 0", fontWeight: 600 } },
            "Quyền hiệu lực của bạn (myAccess): " +
              (myAccess.hasAccess ? "Được cấp quyền" : "Chưa được cấp quyền") +
              " · Thực thi: " +
              (myAccess.enforcementStatus === "enforced"
                ? "Đang thực thi (Enforced)"
                : myAccess.enforcementStatus === "not_enforced"
                  ? "Chưa thực thi (Not enforced)"
                  : "Chế độ tương thích cũ (Legacy)"),
          ),
          h(
            "div",
            { style: { fontSize: 13, color: "#15803d" } },
            "Vai trò quy trình: " +
              (myAccess.effectiveRoles?.length
                ? myAccess.effectiveRoles.map((r) => roleLabels[r] || r).join(", ")
                : "Thành viên dữ liệu (không có vai trò quy trình)"),
          ),
          myAccess.sources?.length > 0 &&
            h(
              "div",
              { style: { marginTop: 6, borderTop: "1px dashed #bbf7d0", paddingTop: 6 } },
              h("strong", { style: { fontSize: 12 } }, "Nguồn phân quyền:"),
              ...myAccess.sources.map((src, i) =>
                h(
                  "div",
                  { key: i, style: { fontSize: 12, marginLeft: 8 } },
                  (src.source === "person" ? "• Cá nhân (" : "• Phòng ban (") +
                    (src.source === "person" ? personMap[src.principalId] || src.principalId : deptMap[src.principalId] || src.principalId) +
                    "): " +
                    (src.roles?.length ? src.roles.map((r) => roleLabels[r] || r).join(", ") : "thành viên dữ liệu"),
                ),
              ),
            ),
        ),

      // Policy Status & Explicit Activation
      selectedSystem &&
        h(
          "div",
          {
            style: {
              background: policy?.status === "enforced" ? "#f8fafc" : "#fffbeb",
              border: policy?.status === "enforced" ? "1px solid #e2e8f0" : "1px solid #fef3c7",
              padding: "10px 14px",
              borderRadius: 6,
              marginBottom: 16,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 8,
            },
          },
          h(
            "div",
            null,
            h(
              "p",
              { style: { margin: "0 0 4px 0", fontWeight: 600 } },
              "Chính sách thực thi phân quyền: " +
                (policy?.status === "enforced"
                  ? `Đang thực thi (Revision: ${policy.revision})`
                  : "Chưa kích hoạt thực thi (Mặc định mở legacy cho đến khi kích hoạt)"),
            ),
            h(
              "span",
              { style: { fontSize: 13, color: "#64748b" } },
              policy?.status === "enforced"
                ? "Tất cả truy cập vào hệ thống này đều bắt buộc phải có thành viên được phân quyền."
                : "Phân quyền đã cấp chỉ có hiệu lực bắt buộc sau khi nhấn nút kích hoạt thực thi bên phải.",
            ),
          ),
          canManage &&
            policy?.status !== "enforced" &&
            button("Kích hoạt thực thi chính sách", () => act(handleActivatePolicy), blocked),
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
          systemRoles.length > 0
            ? h(
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
              )
            : h(
                "p",
                { style: { margin: 0, fontSize: 13, color: "#64748b" } },
                "Hệ thống không định nghĩa vai trò quy trình kinh doanh. Thành viên được phân quyền sẽ truy cập tài nguyên dữ liệu với vai trò rỗng (roles: []).",
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
              marginBottom: 16,
            },
          },
          error,
        ),

      // Grant / Edit Permission Section
      canManage &&
        h(
          "fieldset",
          {
            style: { ...box, background: "#fafafa", borderColor: "#cbd5e1", marginBottom: 20 },
            disabled: blocked,
          },
          h(
            "legend",
            { style: { fontWeight: 600, padding: "0 6px" } },
            editingMember ? `Sửa vai trò thành viên (${editingMember.principalType}: ${editingMember.principalId} · Rev: ${editingMember.revision})` : "Cấp quyền truy cập hệ thống",
          ),
          h(
            "p",
            null,
            editingMember
              ? "Thay đổi vai trò cho thành viên. Yêu cầu revision kiểm tra CAS chống xung đột ghi đè."
              : "Chọn loại chủ thể (cá nhân hoặc phòng ban) từ danh bạ doanh nghiệp và gán vai trò tương ứng trong hệ thống:",
          ),

          !editingMember &&
            h(
              "div",
              { style: { marginBottom: 12, display: "flex", gap: 16, alignItems: "center" } },
              h("strong", null, "Đối tượng cấp quyền: "),
              h(
                "label",
                { style: { cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 } },
                h("input", {
                  type: "radio",
                  name: "principalType",
                  value: "person",
                  checked: principalType === "person",
                  onChange: () => {
                    setPrincipalType("person");
                    setNewPrincipalId("");
                  },
                }),
                " Nhân viên cá nhân",
              ),
              h(
                "label",
                { style: { cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 } },
                h("input", {
                  type: "radio",
                  name: "principalType",
                  value: "department",
                  checked: principalType === "department",
                  onChange: () => {
                    setPrincipalType("department");
                    setNewPrincipalId("");
                  },
                }),
                " Toàn thể phòng ban",
              ),
            ),

          !editingMember &&
            principalType === "person" &&
            h(
              "div",
              { style: { display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 12 } },
              field("Tìm kiếm nhân viên", search, setSearch),
              h(
                "label",
                { style: { display: "inline-flex", flexDirection: "column", gap: 4 } },
                "Lọc theo phòng ban",
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

          !editingMember &&
            h(
              "div",
              { style: { marginTop: 10, marginBottom: 12 } },
              h("strong", null, principalType === "person" ? "Chọn nhân viên: " : "Chọn phòng ban: "),
              principalType === "person"
                ? h(
                    "select",
                    {
                      value: newPrincipalId,
                      onChange: (e) => setNewPrincipalId(e.target.value),
                      style: { padding: "8px 12px", minWidth: 300, borderRadius: 4 },
                    },
                    h("option", { value: "" }, "-- Chọn nhân viên --"),
                    ...availablePeople.map((p) =>
                      h(
                        "option",
                        { key: p.subject, value: p.subject },
                        `${p.displayName || p.subject} (${deptMap[p.departmentId] || p.departmentId || "Chưa gắn phòng"})`,
                      ),
                    ),
                  )
                : h(
                    "select",
                    {
                      value: newPrincipalId,
                      onChange: (e) => setNewPrincipalId(e.target.value),
                      style: { padding: "8px 12px", minWidth: 300, borderRadius: 4 },
                    },
                    h("option", { value: "" }, "-- Chọn phòng ban --"),
                    ...departments.items.map((d) =>
                      h("option", { key: d.id, value: d.id }, `${d.name} (${d.id})`),
                    ),
                  ),
            ),

          // Roles checkboxes
          systemRoles.length > 0 &&
            h(
              "div",
              { style: { margin: "12px 0" } },
              h("strong", null, "Chọn vai trò quy trình trong hệ thống:"),
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

          editingMember
            ? h(
                "div",
                { style: { display: "flex", gap: 10 } },
                button("Lưu thay đổi vai trò", () => act(handleUpdate), blocked),
                button("Hủy chỉnh sửa", () => {
                  setEditingMember(null);
                  setNewPrincipalId("");
                  setSelectedRoles([]);
                }),
              )
            : button(
                "Cấp quyền truy cập",
                () => act(handleGrant),
                blocked || !newPrincipalId,
              ),
        ),

      // Members List Table
      h("h3", null, "Danh sách chủ thể đã được phân quyền"),
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
                  ...[
                    "Loại",
                    "Chủ thể / Tài khoản",
                    "Vai trò trong hệ thống",
                    "Phiên bản ghi",
                    "Trạng thái",
                    "",
                  ].map((th) => h("th", { key: th, style: { padding: "8px 12px" } }, th)),
                ),
              ),
              h(
                "tbody",
                null,
                ...members.items.map((m) =>
                  h(
                    "tr",
                    {
                      key: `${m.principalType}:${m.principalId}`,
                      style: { borderBottom: "1px solid #e2e8f0" },
                    },
                    h(
                      "td",
                      { style: { padding: "8px 12px" } },
                      m.principalType === "person" ? "Cá nhân" : "Phòng ban",
                    ),
                    h(
                      "td",
                      { style: { padding: "8px 12px" } },
                      h(
                        "strong",
                        null,
                        m.principalType === "person"
                          ? personMap[m.principalId] || m.principalId
                          : deptMap[m.principalId] || m.principalId,
                      ),
                      h(
                        "small",
                        { style: { display: "block", color: "#64748b" } },
                        m.principalId,
                      ),
                    ),
                    h(
                      "td",
                      { style: { padding: "8px 12px" } },
                      m.roles?.length
                        ? m.roles.map((r) => roleLabels[r] || r).join(", ")
                        : "Thành viên dữ liệu (roles: [])",
                    ),
                    h(
                      "td",
                      { style: { padding: "8px 12px" } },
                      `Rev: ${m.revision ?? 1}`,
                    ),
                    h(
                      "td",
                      { style: { padding: "8px 12px" } },
                      h(
                        "span",
                        {
                          style: {
                            background: m.status === "active" ? "#dcfce7" : "#fee2e2",
                            color: m.status === "active" ? "#15803d" : "#b91c1c",
                            padding: "2px 6px",
                            borderRadius: 4,
                            fontSize: 12,
                          },
                        },
                        m.status === "active" ? "Đang hiệu lực" : "Đã thu hồi",
                      ),
                    ),
                    h(
                      "td",
                      { style: { padding: "8px 12px", textAlign: "right" } },
                      canManage &&
                        m.status === "active" &&
                        button(
                          "Sửa vai trò",
                          () => {
                            setEditingMember(m);
                            setPrincipalType(m.principalType);
                            setNewPrincipalId(m.principalId);
                            setSelectedRoles(m.roles || []);
                          },
                          blocked,
                        ),
                      canManage &&
                        m.status === "active" &&
                        button(
                          "Thu hồi",
                          () => act(() => handleRevoke(m)),
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
                "Chưa có tài khoản hoặc phòng ban nào được phân quyền trong hệ thống này.",
              ),
              h(
                "p",
                { style: { margin: "4px 0 0 0", fontSize: 13 } },
                "Nhấn 'Cấp quyền truy cập' ở trên để thêm người dùng hoặc phòng ban.",
              ),
            ),
    );
  };
}

module.exports = { createMemberPermissions };
