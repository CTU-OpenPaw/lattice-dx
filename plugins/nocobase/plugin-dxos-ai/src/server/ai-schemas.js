/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { redactPiiText, redactPiiDeep, replaceSecretKvPairs, normalizeTokenUsage } = require('./ai-governance');
const { runWithTenantRls, runWithSystemRlsBypass, runInRlsSavepoint } = require('./ai-rls');

const LEGACY_WORKFLOW_TASKS_TOOL = ['dxos_my_tasks_co', 'pilot'].join('');
const CANONICAL_WORKFLOW_TASKS_TOOL = 'dxos_my_workflow_tasks';

function normalizeToolPermissionsMap(rawPerms) {
  let parsed = rawPerms;
  if (typeof parsed === 'string' && parsed.trim().startsWith('{')) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out = {};
  for (const [rawKey, modeVal] of Object.entries(parsed)) {
    const trimmed = String(rawKey || '').trim();
    if (!trimmed || trimmed === LEGACY_WORKFLOW_TASKS_TOOL) continue;
    out[trimmed] = modeVal;
  }
  if (
    Object.prototype.hasOwnProperty.call(parsed, LEGACY_WORKFLOW_TASKS_TOOL)
    && !Object.prototype.hasOwnProperty.call(out, CANONICAL_WORKFLOW_TASKS_TOOL)
  ) {
    out[CANONICAL_WORKFLOW_TASKS_TOOL] = parsed[LEGACY_WORKFLOW_TASKS_TOOL];
  }
  return out;
}

const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const ORG_RE = /^[-a-zA-Z0-9_]{1,80}$/;

function getEnvDefaultOrgId(env = process.env) {
  const candidate = String(env?.DX_DEFAULT_ORG_ID || '').trim();
  return candidate && candidate.toLowerCase() !== 'all' ? candidate : '';
}

async function resolveFirstActiveOrganizationId(db) {
  const orgRepo = db?.getRepository?.('latticeOrganizations');
  if (!orgRepo || typeof orgRepo.find !== 'function') return '';
  try {
    const rows = (await orgRepo.find({ limit: 50 })) || [];
    for (const row of rows) {
      const readField = (k) => (typeof row?.get === 'function' ? row.get(k) : row?.[k]);
      const orgId = String(readField('organizationId') || '').trim();
      if (!orgId || orgId.toLowerCase() === 'all') continue;
      if (readField('active') === false) continue;
      const status = String(readField('status') || 'active').trim().toLowerCase();
      if (status === 'inactive' || status === 'disabled') continue;
      return orgId;
    }
  } catch {
    // Non-fatal in minimal mock harnesses
  }
  return '';
}

async function resolveDefaultOrganizationId(db, { actor = null, ctx = null, env = process.env, fallback = '' } = {}) {
  const actorOrg = String(actor?.organizationId || '').trim();
  if (actorOrg && actorOrg.toLowerCase() !== 'all') return actorOrg;
  const ctxOrg = String(ctx?.state?.defaultOrgId || '').trim();
  if (ctxOrg && ctxOrg.toLowerCase() !== 'all') return ctxOrg;
  const envOrg = getEnvDefaultOrgId(env);
  if (envOrg) return envOrg;
  const firstOrg = await resolveFirstActiveOrganizationId(db);
  if (firstOrg) return firstOrg;
  return String(fallback || '').trim();
}
const SENSITIVE_KEY_RE = /token|secret|password|apikey|api_key|authorization|cookie|credential|jwt|bearer|privatekey|private_key|sessionid|session_id|passphrase|access_key|client_secret/i;
const VALID_MODES = new Set(['ALLOW', 'ASK', 'OFF']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', 'host.docker.internal']);
const STACK_HTTP_HOSTS = new Set(['orion-ld', 'n8n', 'keycloak', 'nocobase', 'lattice-dx-orion-ld', 'lattice-dx-n8n', 'lattice-dx-keycloak']);
const SSRF_BLOCKED_HOST_RE = /^(0\.0\.0\.0|\[?::\]?|\[?::ffff:.*|169\.254\.\d+\.\d+|fe80:.*|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|127\.\d+\.\d+\.\d+|metadata\.google\.internal|metadata\.azure\.com)$/i;

const STARTER_AI_BLUEPRINTS = [
  {
    username: 'dxos-coordinator',
    nickname: 'Tổng Điều phối viên DX-OS',
    position: 'AI Điều phối Đa-Agent Trung tâm',
    departmentScope: 'enterprise-wide',
    avatar: 'nocobase-044-male',
    bio: 'Phân tích yêu cầu phức tạp, điều phối tác nhân chuyên môn đúng thẩm quyền và tổng hợp kết quả.',
    greeting: 'Xin chào! Tôi là Điều phối viên DX-OS. Hãy nêu mục tiêu, tôi sẽ phân rã và phối hợp đúng chuyên viên AI xử lý.',
    systemPrompt: [
      'Bạn là Tổng Điều phối viên của Hệ điều hành Doanh nghiệp LatticeDX (tầng 6 phân hệ).',
      'Khi nhận yêu cầu đa phòng ban hoặc yêu cầu kỹ thuật sâu, hãy ưu tiên tra cứu hoặc điều phối sang đúng chuyên viên AI (dxos-ops, dxos-logistics, dxos-workspace, hoặc dxos-architect nếu người gọi là Admin).',
      'Luôn trả lời bằng tiếng Việt ngắn gọn, nêu rõ nguồn bản ghi [collection:code#id] hoặc tool đã thực thi.',
    ].join('\n'),
    llmService: 'local-9router',
    modelName: 'ag/gemini-3.8-flash',
    enabled: true,
    isAdminBuilder: false,
    allowSubAgentDispatch: true,
    allowedRoles: ['root', 'admin', 'ldx_admin', 'ldx_director', 'ldx_manager', 'ldx_employee', 'ldx_warehouse', 'ldx_dispatcher', 'ldx_driver'],
    toolPermissions: {
      dxos_search_enterprise_context: 'ALLOW',
      dxos_my_workflow_tasks: 'ALLOW',
      dxos_execute_record_action: 'ASK',
      dxos_orchestrate_enterprise_case: 'ASK',
      dxos_graph_impact_analysis: 'ALLOW',
      dxos_alarm_action: 'ASK',
    },
    mcpServers: [{ name: 'dxos-it-ot-mcp', url: 'http://127.0.0.1:13000/api/dxos-mcp/it-ot', useUserContext: true, enabled: true }],
    portalBindings: ['*'],
    quickPrompts: [
      { label: 'Radar 6 phân hệ & điểm nghẽn', prompt: 'Chạy dxos_orchestrate_enterprise_case chế độ radar tổng hợp điểm nghẽn toàn doanh nghiệp.' },
      { label: 'Tìm & điều phối liên thông', prompt: 'Tra cứu các đơn hàng, phiếu dịch vụ, phân hệ tùy chỉnh và sự cố liên quan gần nhất kèm mã tham chiếu.' },
    ],
  },
  {
    username: 'dxos-architect',
    nickname: 'Kiến trúc sư Hệ thống - Block AI',
    position: 'Admin System Builder (Chỉ Root/Admin)',
    departmentScope: 'platform-admin',
    avatar: 'nocobase-002-male',
    bio: 'Kiến trúc sư Hệ thống Toàn diện: tự đọc cấu trúc thật, gợi ý blueprint, sáng tạo block mới an toàn (đủ 12 Native v2 BlockModels gồm WebGIS, Kanban, WMS Ops, BI Chart, Creative Studio), dựng trọn bộ Enterprise App (Rich Schema 12 kiểu trường + Plan-Diff-Approve + Patch/Rollback) kèm Verifier + 2 vòng Self-Healing, cấu hình bảng quyết định DMN, LatticeFlow v2 DAG & quản trị 2 chiều Stock n8n REST API v1, tạo Role + AI Assistant mới và hoàn tác Time-Machine.',
    greeting: 'Chào bạn! Tôi có thể lập kế hoạch & dựng trọn gói phân hệ doanh nghiệp (Rich Schema + RLS + OpenAPI + RBAC + Portal 12 BlockModels + DMN + LatticeFlow v2 + Stock n8n + tự kiểm chứng/tự sửa), cập nhật/hoàn tác phiên bản ứng dụng, quản trị workflow n8n & bảng DMN, hoặc hoàn tác giao diện chỉ qua tiếng Việt tự nhiên.',
    systemPrompt: [
      'Bạn là Kiến trúc sư Hệ thống & Giao diện LatticeDX (dành cho Quản trị viên).',
      'Khi mở chat trên bất kỳ portal nào, ngữ cảnh ngầm sẽ đính kèm [Ngữ cảnh trang hiện tại: portalSlug="...", pageTitle="..."]. Hãy TỰ ĐỘNG đọc portalSlug & pageTitle từ đó.',
      'QUY TẮC GIAO TIẾP TỰ NHIÊN:',
      '- Người dùng sẽ nói tiếng Việt đời thường (ví dụ: "đặt ngang cạnh phần chỉ số", "cảnh báo đỏ nếu nhiệt độ cao hơn âm 15 độ", "xây dựng phân hệ Quản lý Bảo trì kèm DMN và WebGIS", "tạo flow khi yêu cầu mua sắm > 50 triệu thì tạm dừng chờ giám đốc phê duyệt HITL", "hoàn tác trang này về bố cục 1 cột ban đầu").',
      '- TUYỆT ĐỐI KHÔNG BAO GIỜ hỏi người dùng nhập mã blockUid, portalSlug, collectionName, roleName dạng ldx_*, hay JSON.',
      '- Hành động ngay (dryRun=false) khi quản trị viên yêu cầu tạo, sửa, thêm khối, dựng ứng dụng, tạo vai trò hoặc hoàn tác:',
      '  1) Xem khối/gợi ý cho trang hiện tại: gọi dxos_compose_page_blocks(action="listBlocks", portalSlug=...) hoặc dxos_recommend_page_blueprint(portalSlug=...).',
      '  2) Thiết kế & gắn khối sáng tạo mới (gauge, nhiệt kế, cảnh báo đỏ, pipeline, thao tác nhanh): gọi dxos_design_creative_block với portalSlug, pageTitle, title, theme ("industrial-cockpit" | "emerald-ops" | "amber-alert" | "royal-indigo" | "clean-light"), placeBesideTitle (tên tiếng Việt như "Chỉ số" nếu muốn đặt ngang 2 cột), goal (mô tả yêu cầu) và dryRun=false.',
      '  3) Thêm hoặc sửa block chuẩn NocoBase hoặc 12 Native v2 BlockModels (bao gồm DxosWebGisBlockModel, DxosKanbanScheduleBlockModel, DxosWmsOpsBlockModel, DxosBiChartBlockModel hỗ trợ bar/line/pie/kpi/pivot): dùng dxos_compose_page_blocks.',
      '  4) Mở rộng bảng & trường Rich Schema (12 kiểu: string, text, integer, float, boolean, date, datetime, json, belongsTo, hasOne, belongsToMany kèm bảng trung gian FORCE RLS, formula AST thuần JS, validation ràng buộc required/unique/min/max/pattern/enum): gọi dxos_extend_collection_schema.',
      '  5) Tạo vai trò mới hoặc lập kế hoạch / dựng trọn gói / nâng cấp / hoàn tác ứng dụng đa thực thể (Multi-Entity App Builder 2.0) kèm kiểm chứng & tự sửa:',
      '     - Lập kế hoạch dry-run (không ghi DB, trả về ER Graph + Diff): gọi dxos_provision_role_workspace với operation="plan_enterprise_app".',
      '     - Dựng mới trọn gói: gọi dxos_provision_role_workspace với operation="build_enterprise_app".',
      '     - Cập nhật tăng dần có snapshot: gọi operation="patch_enterprise_app" (truyền appKey + patch hoặc prompt); hoàn tác 1 chạm về phiên bản trước: operation="rollback_enterprise_app" (appKey, targetVersion).',
      '     - Với ứng dụng nhiều bảng cha-con, truyền collections: [{ collectionName: "latticeCustom<TenBang>", collectionTitle: "...", fields: [..., { name: "refName", title: "...", type: "belongsTo", target: "latticeCustom<BangCha>" }] }] (hỗ trợ belongsTo, hasOne, belongsToMany, formula, validation; chỉ dùng bảng bắt đầu bằng latticeCustom*, TUYỆT ĐỐI KHÔNG sửa bảng hệ thống như users/roles/latticeBuiltApps). Hệ thống tự sắp xếp thứ tự topo Kahn & bật FORCE RLS.',
      '     - Với Kanban/WebGIS/RecordWorkbench/BI Chart động theo bảng tự dựng, khai báo portals[].blocks với blockUse ("DxosKanbanScheduleBlockModel" | "DxosWebGisBlockModel" | "DxosRecordWorkbenchBlockModel" | "DxosBiChartBlockModel") và collection: "latticeCustom<TenBang>".',
      '     - Quản lý vòng đời ứng dụng đã dựng qua operation: "plan_enterprise_app" | "build_enterprise_app" | "patch_enterprise_app" | "rollback_enterprise_app" | "list_built_apps" | "rebuild_enterprise_app" | "export_app_bundle" (Bundle v3) | "teardown_built_app" (mặc định keepData=true) | "verify_app".',
      '  6) Hoàn tác giao diện: gọi dxos_snapshot_or_rollback_page(action="rollback", portalSlug=..., pageTitle=...).',
      '  7) LatticeFlow v2 (DX-OS Flow Architect), DMN & Stock n8n REST API v1: gọi dxos_configure_workflow với operation="listAutomations" | "draftAutomation" | "patchAutomation" | "suggestAutomation" | "testAutomation" | "resumeAutomation" | "saveAutomation" | "runAutomation", hoặc quản lý bảng quyết định DMN ("dmn_list_tables" | "dmn_save_table" | "dmn_evaluate"), hoặc quản trị kết nối/workflow Stock n8n ("listConnectors" | "testConnector" | "invokeN8n" | "list_connected_apps" | "list_n8n_workflows" | "create_n8n_workflow" | "update_n8n_workflow" | "activate_n8n_workflow" | "list_n8n_executions" | "retry_n8n_execution" | "sync_n8n_credential"). Chỉ đặt apply=true khi quản trị viên xác nhận lưu thay đổi.',
      '  8) Bộ nhớ Ngữ cảnh Bền vững (latticeAiMemory): sử dụng dxos_memory_recall để truy hồi quy chuẩn/quyết định kiến trúc trước đó, dxos_memory_remember để lưu tri thức tổ chức/agent dài hạn, và dxos_memory_forget (ASK) khi cần xóa ký ức lỗi thời.',
      'Khi trả lời, hãy dùng ngôn ngữ thân thiện, dễ hiểu cho người quản trị (nêu tên khối, tên trang, tên vai trò, kết quả kiểm chứng, tên luồng tự động và các bước sẽ chạy hay bỏ qua; không rải mã kỹ thuật rối mắt).',
    ].join('\n'),
    llmService: 'local-9router',
    modelName: 'ag/gemini-3.8-flash',
    enabled: true,
    isAdminBuilder: true,
    allowSubAgentDispatch: false,
    allowedRoles: ['root', 'admin'],
    toolPermissions: {
      dxos_inspect_architecture: 'ALLOW',
      dxos_recommend_page_blueprint: 'ALLOW',
      dxos_design_creative_block: 'ALLOW',
      dxos_compose_page_blocks: 'ALLOW',
      dxos_snapshot_or_rollback_page: 'ALLOW',
      dxos_provision_role_workspace: 'ALLOW',
      dxos_manage_portal_and_acl: 'ALLOW',
      dxos_extend_collection_schema: 'ALLOW',
      dxos_manage_rbac_permissions: 'ALLOW',
      dxos_deploy_workflow: 'ALLOW',
      dxos_configure_workflow: 'ALLOW',
      dxos_search_enterprise_context: 'ALLOW',
      dxos_orchestrate_enterprise_case: 'ALLOW',
      dxos_graph_impact_analysis: 'ALLOW',
      dxos_memory_remember: 'ALLOW',
      dxos_memory_recall: 'ALLOW',
      dxos_memory_forget: 'ASK',
    },
    mcpServers: [{ name: 'dxos-it-ot-mcp', url: 'http://127.0.0.1:13000/api/dxos-mcp/it-ot', useUserContext: true, enabled: true }],
    portalBindings: ['*'],
    quickPrompts: [
      { label: 'Xem cấu trúc & gợi ý khối mới', prompt: 'Xem giúp tôi trang này đang có những khối nào và gợi ý xem nên bổ sung thêm khối gì dễ theo dõi hơn.' },
      { label: 'Thêm khối theo dõi đặt 2 cột', prompt: 'Thiết kế giúp tôi một khối theo dõi mới đặt ngang cạnh phần chỉ số hiện tại trên trang này.' },
      { label: 'Tạo vai trò & trang riêng mới', prompt: 'Tạo giúp tôi một vai trò mới kèm phân quyền phù hợp, trang làm việc riêng và một trợ lý AI cho đội mới.' },
      { label: 'Dựng ứng dụng Đa thực thể mới', prompt: 'Dựng trọn gói ứng dụng Quản lý Phòng khám đa thực thể gồm 2 bảng Bác sĩ và Lịch khám (có belongsTo), bảng Kanban lịch khám theo trạng thái, phân quyền riêng và quy trình cảnh báo.' },
      { label: 'Dựng luồng tự động hóa mới', prompt: 'Tạo automation khi nhiệt độ kho lạnh vượt âm 15 độ thì mở phiếu bảo trì và cảnh báo quản lý ca trực.' },
      { label: 'Gợi ý tối ưu & chạy thử tự động hóa', prompt: 'Phân tích và gợi ý tối ưu quy trình tự động hóa hiện có, đồng thời mô phỏng chạy thử các nhánh xử lý.' },
    ],
  },
  {
    username: 'dxos-ops',
    nickname: 'Chuyên viên Kho lạnh - Sự cố IoT AI',
    position: 'Kỹ sư AI Vận hành IT/OT',
    departmentScope: 'operations-itot',
    avatar: 'nocobase-001-male',
    bio: 'Giám sát ngữ cảnh FIWARE Orion-LD qua MCP, đối chiếu SOP P.A.R.A. và lập phiếu bảo trì hoặc phân tích ca sự cố liên phòng ban.',
    greeting: 'Xin chào! Tôi theo dõi cảm biến Orion-LD, hàng đợi sự cố và sẵn sàng lập phiếu bảo trì hoặc biên bản liên thông trực tiếp.',
    systemPrompt: [
      'Bạn là Chuyên viên AI Kho lạnh & Sự cố IoT.',
      'Hãy gọi MCP tools (get_live_ngsi_telemetry, get_sensor_and_incident_timeline) kết hợp dxos_orchestrate_enterprise_case và dxos_search_enterprise_context để đối chiếu SOP P.A.R.A. trước khi lập chuỗi phiếu xử lý.',
      'Không tự phê duyệt đóng case hay sửa trường bị RBAC khóa; luôn dẫn rõ ID/URN nguồn.',
    ].join('\n'),
    llmService: 'local-9router',
    modelName: 'ag/gemini-3.8-flash',
    enabled: true,
    isAdminBuilder: false,
    allowSubAgentDispatch: false,
    allowedRoles: ['root', 'admin', 'ldx_admin', 'ldx_director', 'ldx_manager', 'ldx_employee', 'ldx_warehouse'],
    toolPermissions: {
      dxos_search_enterprise_context: 'ALLOW',
      dxos_execute_record_action: 'ASK',
      dxos_my_workflow_tasks: 'ALLOW',
      dxos_orchestrate_enterprise_case: 'ASK',
      dxos_graph_impact_analysis: 'ALLOW',
      dxos_alarm_action: 'ASK',
    },
    mcpServers: [{ name: 'dxos-it-ot-mcp', url: 'http://127.0.0.1:13000/api/dxos-mcp/it-ot', useUserContext: true, enabled: true }],
    portalBindings: ['incidents', 'procurement'],
    quickPrompts: [
      { label: 'Đọc telemetry Orion-LD trực tiếp', prompt: 'Gọi get_live_ngsi_telemetry và get_sensor_and_incident_timeline kiểm tra tình trạng kho lạnh hiện tại.' },
      { label: 'Điều phối xử lý sự cố 360°', prompt: 'Dùng dxos_orchestrate_enterprise_case đối chiếu sự cố, SOP P.A.R.A. và đề xuất chuỗi phiếu bảo trì liên thông.' },
    ],
  },
  {
    username: 'dxos-logistics',
    nickname: 'Điều phối viên Chuỗi lạnh 5 Bước AI',
    position: 'Chuyên viên AI Vận tải & Điều phối',
    departmentScope: 'logistics-5step',
    avatar: 'nocobase-003-female',
    bio: 'Hỗ trợ theo dõi đơn vận chuyển 5 bước liên phòng ban, radar điểm nghẽn, đối soát công việc thủ công và tạo nháp đơn hàng đúng chuẩn.',
    greeting: 'Chào bạn! Tôi hỗ trợ theo dõi đơn vận chuyển 5 chặng, radar điểm nghẽn và tóm tắt công việc giao nhận của bạn.',
    systemPrompt: [
      'Bạn là Điều phối viên Chuỗi lạnh AI của LatticeDX.',
      'Dùng dxos_search_enterprise_context đọc trạng thái latticeOrders, dxos_orchestrate_enterprise_case xem radar, và dxos_my_workflow_tasks kiểm tra manual task đang giao cho người dùng.',
      'Chỉ nộp bước manual task khi được người dùng xác nhận qua ASK.',
    ].join('\n'),
    llmService: 'local-9router',
    modelName: 'ag/gemini-3.8-flash',
    enabled: true,
    isAdminBuilder: false,
    allowSubAgentDispatch: false,
    allowedRoles: ['root', 'admin', 'ldx_admin', 'ldx_director', 'ldx_manager', 'ldx_employee', 'ldx_warehouse', 'ldx_dispatcher', 'ldx_driver'],
    toolPermissions: {
      dxos_search_enterprise_context: 'ALLOW',
      dxos_execute_record_action: 'ASK',
      dxos_my_workflow_tasks: 'ASK',
      dxos_orchestrate_enterprise_case: 'ALLOW',
      dxos_graph_impact_analysis: 'ALLOW',
    },
    mcpServers: [{ name: 'dxos-it-ot-mcp', url: 'http://127.0.0.1:13000/api/dxos-mcp/it-ot', useUserContext: true, enabled: true }],
    portalBindings: ['logistics'],
    quickPrompts: [
      { label: 'Việc giao nhận đang chờ tôi', prompt: 'Dùng dxos_my_workflow_tasks liệt kê và tóm tắt các công việc logistics đang chờ tôi xử lý.' },
      { label: 'Rà soát đơn chuỗi lạnh', prompt: 'Tìm các đơn vận chuyển chuỗi lạnh đang mở và đối chiếu lộ trình mới nhất.' },
    ],
  },
  {
    username: 'dxos-workspace',
    nickname: 'Trợ lý Nội bộ, Mua sắm và P.A.R.A. AI',
    position: 'Chuyên viên AI Dịch vụ & Tri thức',
    departmentScope: 'workspace-para',
    avatar: 'nocobase-004-female',
    bio: 'Tra cứu tri thức P.A.R.A. có trích dẫn nguồn, tạo yêu cầu mua sắm / phiếu dịch vụ / phân hệ tùy chỉnh và điều phối liên phòng ban.',
    greeting: 'Xin chào! Tôi có thể tra cứu SOP P.A.R.A., soạn phiếu dịch vụ, lập biên bản phân hệ mới hoặc tóm tắt hộp việc giúp bạn.',
    systemPrompt: [
      'Bạn là Trợ lý Dịch vụ Nội bộ & Kho tri thức P.A.R.A.',
      'Mọi hướng dẫn đều phải trích dẫn nguồn [latticeParaDocuments:code#id].',
      'Khi tạo bản ghi mới qua dxos_execute_record_action hoặc dxos_orchestrate_enterprise_case, luôn tuân thủ RBAC và để người dùng xác nhận.',
    ].join('\n'),
    llmService: 'local-9router',
    modelName: 'ag/gemini-3.8-flash',
    enabled: true,
    isAdminBuilder: false,
    allowSubAgentDispatch: false,
    allowedRoles: ['root', 'admin', 'ldx_admin', 'ldx_director', 'ldx_manager', 'ldx_employee'],
    toolPermissions: {
      dxos_search_enterprise_context: 'ALLOW',
      dxos_execute_record_action: 'ASK',
      dxos_my_workflow_tasks: 'ALLOW',
      dxos_orchestrate_enterprise_case: 'ASK',
      dxos_graph_impact_analysis: 'ALLOW',
      dxos_alarm_action: 'ASK',
    },
    mcpServers: [],
    portalBindings: ['services', 'procurement'],
    quickPrompts: [
      { label: 'Tra cứu SOP trong Kho P.A.R.A.', prompt: 'Tìm tài liệu SOP/Projects trong Kho tri thức P.A.R.A. kèm trích dẫn nguồn.' },
      { label: 'Lập phiếu dịch vụ / mua sắm', prompt: 'Hỗ trợ soạn phiếu dịch vụ nội bộ hoặc yêu cầu mua sắm theo thông tin tôi cung cấp.' },
    ],
  },
  {
    username: 'dxos-operator',
    nickname: 'Chuyên viên Thực thi Vận hành DX-OS',
    position: 'Chuyên viên AI Thực thi & Tác vụ IT/OT',
    departmentScope: 'operations-execution',
    avatar: 'nocobase-005-male',
    bio: 'Thực thi tác vụ vận hành có kiểm soát, giám sát telemetry IT/OT, phân loại sự cố và phối hợp xử lý cảnh báo theo RBAC & HITL.',
    greeting: 'Xin chào! Tôi là DX-OS Operator — sẵn sàng thực thi tác vụ vận hành, kiểm tra telemetry và xử lý cảnh báo đúng thẩm quyền.',
    systemPrompt: [
      'Bạn là Chuyên viên Thực thi Vận hành DX-OS (dxos-operator).',
      'Thực thi các tác vụ vận hành có kiểm soát trong đúng phạm vi tổ chức và RBAC của người gọi; luôn truy hồi bối cảnh liên quan qua dxos_memory_recall / dxos_search_enterprise_context và ghi nhận quyết định quan trọng bằng dxos_memory_remember.',
      'Các hành động ghi dữ liệu hoặc xử lý cảnh báo (dxos_execute_record_action, dxos_alarm_action) phải tuân thủ cơ chế xác nhận ASK/HITL và dẫn rõ mã tham chiếu [collection:code#id].',
    ].join('\n'),
    llmService: 'local-9router',
    modelName: 'ag/gemini-3.8-flash',
    enabled: true,
    isAdminBuilder: false,
    allowSubAgentDispatch: false,
    allowedRoles: ['root', 'admin', 'ldx_admin', 'ldx_director', 'ldx_manager', 'ldx_operator', 'ldx_dispatcher', 'ldx_warehouse'],
    toolPermissions: {
      dxos_search_enterprise_context: 'ALLOW',
      dxos_my_workflow_tasks: 'ALLOW',
      dxos_execute_record_action: 'ASK',
      dxos_alarm_action: 'ASK',
      dxos_memory_recall: 'ALLOW',
      dxos_memory_remember: 'ALLOW',
    },
    mcpServers: [{ name: 'dxos-it-ot-mcp', url: 'http://127.0.0.1:13000/api/dxos-mcp/it-ot', useUserContext: true, enabled: true }],
    portalBindings: ['incidents', 'logistics', 'services'],
    quickPrompts: [
      { label: 'Kiểm tra telemetry & sự cố vận hành', prompt: 'Kiểm tra telemetry trực tiếp và các sự cố hoặc tác vụ vận hành đang mở trong ca trực.' },
      { label: 'Đối chiếu ký ức & SOP ca trực', prompt: 'Dùng dxos_memory_recall tìm lại quy ước vận hành và lịch sử xử lý cảnh báo gần đây.' },
    ],
  },
  {
    username: 'dxos-analyst',
    nickname: 'Chuyên gia Phân tích Dữ liệu - GraphRAG DX-OS',
    position: 'Chuyên gia AI Phân tích Liên phòng ban & BI',
    departmentScope: 'analytics-bi',
    avatar: 'nocobase-006-female',
    bio: 'Phân tích số liệu liên phòng ban, truy vết tác động GraphRAG, chẩn đoán điểm nghẽn SLA và tổng hợp chỉ số KPI vận hành.',
    greeting: 'Xin chào! Tôi là DX-OS Analyst — sẵn sàng phân tích số liệu KPI, truy vết tác động GraphRAG và chẩn đoán điểm nghẽn SLA.',
    systemPrompt: [
      'Bạn là Chuyên gia Phân tích Doanh nghiệp DX-OS (dxos-analyst).',
      'Sử dụng dxos_graph_impact_analysis, dxos_orchestrate_enterprise_case (chế độ radar), dxos_search_enterprise_context và dxos_memory_recall để phân tích chỉ số tổ chức, phả hệ tác động và điểm nghẽn SLA.',
      'Trả lời có cấu trúc số liệu rõ ràng, không suy diễn ngoài dữ liệu đã truy xuất và luôn trích dẫn [collection:code#id].',
    ].join('\n'),
    llmService: 'local-9router',
    modelName: 'ag/gemini-3.8-flash',
    enabled: true,
    isAdminBuilder: false,
    allowSubAgentDispatch: false,
    allowedRoles: ['root', 'admin', 'ldx_admin', 'ldx_director', 'ldx_manager', 'ldx_employee'],
    toolPermissions: {
      dxos_search_enterprise_context: 'ALLOW',
      dxos_graph_impact_analysis: 'ALLOW',
      dxos_orchestrate_enterprise_case: 'ALLOW',
      dxos_memory_recall: 'ALLOW',
    },
    mcpServers: [],
    portalBindings: ['*'],
    quickPrompts: [
      { label: 'Phân tích tác động GraphRAG', prompt: 'Chạy phân tích tác động GraphRAG và tóm tắt các lô, đơn hàng, sự cố liên quan.' },
      { label: 'Chẩn đoán KPI & điểm nghẽn SLA', prompt: 'Tổng hợp radar liên phòng ban, đánh giá điểm nghẽn SLA và đề xuất ưu tiên xử lý.' },
    ],
  },
];

const aiProfiles = {
  name: 'latticeAiProfiles',
  title: 'Cấu hình Nhân sự AI LatticeDX',
  titleField: 'nickname',
  origin: '@latticedx/plugin-dxos-ai',
  uiManageable: true,
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'username', type: 'string', interface: 'input', allowNull: false, unique: true },
    { name: 'nickname', type: 'string', interface: 'input', allowNull: false },
    { name: 'position', type: 'string', interface: 'input' },
    { name: 'departmentScope', type: 'string', interface: 'input', defaultValue: 'general' },
    { name: 'organizationId', type: 'string', interface: 'input', allowNull: false },
    { name: 'avatar', type: 'string', interface: 'input', defaultValue: 'nocobase-015-male' },
    { name: 'bio', type: 'text', interface: 'textarea' },
    { name: 'greeting', type: 'text', interface: 'textarea' },
    { name: 'systemPrompt', type: 'text', interface: 'textarea' },
    { name: 'llmService', type: 'string', interface: 'input', defaultValue: 'local-9router' },
    { name: 'modelName', type: 'string', interface: 'input', defaultValue: 'ag/gemini-3.8-flash' },
    { name: 'enabled', type: 'boolean', defaultValue: true, allowNull: false },
    { name: 'isAdminBuilder', type: 'boolean', defaultValue: false, allowNull: false },
    { name: 'allowSubAgentDispatch', type: 'boolean', defaultValue: false, allowNull: false },
    { name: 'allowedRoles', type: 'jsonb', defaultValue: ['ldx_employee', 'ldx_manager'] },
    { name: 'toolPermissions', type: 'jsonb', defaultValue: {} },
    { name: 'mcpServers', type: 'jsonb', defaultValue: [] },
    { name: 'portalBindings', type: 'jsonb', defaultValue: [] },
    { name: 'quickPrompts', type: 'jsonb', defaultValue: [] },
    { name: 'version', type: 'integer', defaultValue: 1, allowNull: false },
  ],
  indexes: [
    { name: 'idx_lattice_ai_profiles_org_enabled', fields: ['organizationId', 'enabled'] },
  ],
};

const aiAuditLogs = {
  name: 'latticeAiAuditLogs',
  title: 'Nhật ký Kiểm toán AI & MCP',
  titleField: 'toolName',
  origin: '@latticedx/plugin-dxos-ai',
  uiManageable: false,
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'actorUserId', type: 'bigInt' },
    { name: 'actorUsername', type: 'string' },
    { name: 'organizationId', type: 'string' },
    { name: 'channel', type: 'string', allowNull: false },
    { name: 'aiEmployee', type: 'string' },
    { name: 'toolName', type: 'string', allowNull: false },
    { name: 'argsSummary', type: 'jsonb', defaultValue: {} },
    { name: 'status', type: 'string', allowNull: false },
    { name: 'durationMs', type: 'integer', defaultValue: 0 },
    { name: 'promptTokens', type: 'integer', defaultValue: 0 },
    { name: 'completionTokens', type: 'integer', defaultValue: 0 },
    { name: 'totalTokens', type: 'integer', defaultValue: 0 },
    { name: 'tokenSource', type: 'string', defaultValue: 'estimated' },
    { name: 'estimatedCostUsd', type: 'double', defaultValue: 0 },
    { name: 'piiRedactedCount', type: 'integer', defaultValue: 0 },
    { name: 'errorCode', type: 'string' },
    { name: 'resultSummary', type: 'text' },
  ],
  indexes: [
    { name: 'idx_lattice_ai_audit_org_created', fields: ['organizationId', 'createdAt'] },
    { name: 'idx_lattice_ai_audit_emp_status_created', fields: ['aiEmployee', 'status', 'createdAt'] },
    { name: 'idx_lattice_ai_audit_actor_created', fields: ['actorUserId', 'createdAt'] },
    { name: 'idx_lattice_ai_audit_tool_created', fields: ['toolName', 'createdAt'] },
  ],
};

const uiSnapshots = {
  name: 'latticeUiSnapshots',
  title: 'Snapshot Bố cục UI DX-OS (Time-Machine)',
  titleField: 'snapshotUid',
  origin: '@latticedx/plugin-dxos-ai',
  uiManageable: false,
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'snapshotUid', type: 'string', interface: 'input', allowNull: false, unique: true },
    { name: 'portalSlug', type: 'string', interface: 'input', allowNull: false },
    { name: 'pageTitle', type: 'string', interface: 'input' },
    { name: 'tabSchemaUid', type: 'string', interface: 'input' },
    { name: 'gridUid', type: 'string', interface: 'input' },
    { name: 'note', type: 'string', interface: 'input' },
    { name: 'createdByUsername', type: 'string', interface: 'input' },
    { name: 'layoutState', type: 'jsonb', defaultValue: {} },
    { name: 'blocks', type: 'jsonb', defaultValue: [] },
  ],
  indexes: [
    { name: 'idx_lattice_ui_snapshots_portal_page_created', fields: ['portalSlug', 'pageTitle', 'createdAt'] },
    { name: 'idx_lattice_ui_snapshots_grid_created', fields: ['gridUid', 'createdAt'] },
  ],
};

const aiQuotaUsage = {
  name: 'latticeAiQuotaUsage',
  title: 'Hạn mức & Chi phí AI theo Ngày',
  titleField: 'dayKey',
  origin: '@latticedx/plugin-dxos-ai',
  uiManageable: false,
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'dayKey', type: 'string', allowNull: false },
    { name: 'userId', type: 'string', allowNull: false },
    { name: 'calls', type: 'integer', defaultValue: 0, allowNull: false },
    { name: 'promptTokens', type: 'bigInt', defaultValue: 0, allowNull: false },
    { name: 'completionTokens', type: 'bigInt', defaultValue: 0, allowNull: false },
    { name: 'costUsd', type: 'double', defaultValue: 0, allowNull: false },
    { name: 'piiRedacted', type: 'integer', defaultValue: 0, allowNull: false },
  ],
  indexes: [
    { name: 'uidx_lattice_ai_quota_org_day_user', fields: ['organizationId', 'dayKey', 'userId'], unique: true },
    { name: 'idx_lattice_ai_quota_org_day', fields: ['organizationId', 'dayKey'] },
  ],
};

const aiApprovalQueue = {
  name: 'latticeAiApprovalQueue',
  title: 'Hàng chờ Phê duyệt Tác vụ AI (HITL)',
  titleField: 'toolName',
  origin: '@latticedx/plugin-dxos-ai',
  uiManageable: false,
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'requesterUserId', type: 'bigInt', allowNull: false },
    { name: 'requesterUsername', type: 'string' },
    { name: 'aiEmployee', type: 'string' },
    { name: 'toolName', type: 'string', allowNull: false },
    { name: 'targetCollection', type: 'string', allowNull: false },
    { name: 'targetRecordId', type: 'bigInt' },
    { name: 'operation', type: 'string', defaultValue: 'update' },
    { name: 'proposedArgs', type: 'jsonb', defaultValue: {} },
    { name: 'diffPreview', type: 'jsonb', defaultValue: {} },
    { name: 'riskLevel', type: 'string', defaultValue: 'medium' },
    { name: 'status', type: 'string', defaultValue: 'pending' },
    { name: 'decidedByUserId', type: 'bigInt' },
    { name: 'decidedByUsername', type: 'string' },
    { name: 'decisionNote', type: 'string' },
    { name: 'decidedAt', type: 'date' },
    { name: 'executionResult', type: 'jsonb' },
    { name: 'expiresAt', type: 'date' },
  ],
  indexes: [
    { name: 'idx_lattice_ai_hitl_org_status_created', fields: ['organizationId', 'status', 'createdAt'] },
  ],
};

function failSchema(code, message, status = 400) {
  return Object.assign(new Error(message || code), { code, status });
}

function validateMcpServerUrl(rawUrl) {
  const str = String(rawUrl || '').trim();
  let parsed;
  try {
    parsed = new URL(str);
  } catch {
    throw failSchema('MCP_URL_INVALID', 'Invalid MCP URL format');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw failSchema('MCP_URL_PROTOCOL_INVALID', 'Only http/https protocols are allowed for MCP URL');
  }
  if (parsed.username || parsed.password) {
    throw failSchema('MCP_URL_CREDENTIALS_FORBIDDEN', 'Credentials inside MCP URL are forbidden');
  }
  const host = parsed.hostname.toLowerCase();
  const bareHost = host.replace(/^\[|\]$/g, '');
  const isLoopbackHost = LOOPBACK_HOSTS.has(host) || LOOPBACK_HOSTS.has(bareHost);
  if (!isLoopbackHost && (SSRF_BLOCKED_HOST_RE.test(host) || SSRF_BLOCKED_HOST_RE.test(bareHost))) {
    throw failSchema('MCP_URL_SSRF_BLOCKED', 'Unsafe SSRF metadata, private, or wildcard host blocked');
  }
  const extraAllowlist = new Set(
    String(process.env.DXOS_MCP_INTERNAL_HTTP_ALLOWLIST || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const isAllowedHttpHost = isLoopbackHost || STACK_HTTP_HOSTS.has(bareHost) || extraAllowlist.has(bareHost);
  if (parsed.protocol === 'http:' && !isAllowedHttpHost) {
    throw failSchema('MCP_URL_HTTPS_REQUIRED', 'External HTTP MCP endpoints must use https:// (or be an allowlisted stack host)');
  }
  return parsed.toString();
}

function redactAuditText(rawText) {
  let text = String(rawText ?? '');
  if (!text) return text;
  text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/g, '[REDACTED_JWT]');
  text = text.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, '$1[REDACTED]');
  text = text.replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED_KEY]');
  text = replaceSecretKvPairs(text).text;
  return text;
}

function sanitizeAuditSummary(value, depth = 0) {
  if (depth > 4) return '[TRUNCATED]';
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}...` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeAuditSummary(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? '[REDACTED]' : sanitizeAuditSummary(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

function validateAiProfilePayload(input = {}, { adminToolNames = [], defaultOrganizationId = '' } = {}) {
  const username = String(input.username || '').trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    throw failSchema('AI_USERNAME_INVALID', 'username phải gồm 2-63 ký tự [a-z0-9_-].');
  }
  const nickname = String(input.nickname || '').trim();
  if (!nickname) {
    throw failSchema('AI_NICKNAME_REQUIRED', 'Vui lòng nhập tên hiển thị của AI Employee.');
  }
  const organizationId = String(input.organizationId || defaultOrganizationId || getEnvDefaultOrgId() || 'default').trim();
  if (!ORG_RE.test(organizationId)) {
    throw failSchema('AI_ORG_INVALID', 'Mã tổ chức không hợp lệ.');
  }
  const toolPermissions = {};
  const rawPerms = input.toolPermissions !== undefined ? input.toolPermissions : input.toolPermissionsJson;
  const normalizedPerms = normalizeToolPermissionsMap(rawPerms);
  for (const [toolName, mode] of Object.entries(normalizedPerms)) {
    const m = String(mode || '').toUpperCase();
    if (!VALID_MODES.has(m)) throw failSchema('AI_TOOL_MODE_INVALID', `Chế độ tool "${m}" không hợp lệ.`);
    if (m !== 'OFF') toolPermissions[String(toolName).trim()] = m;
  }
  const adminSet = new Set(adminToolNames);
  const grantsAdminTool = Object.keys(toolPermissions).some((t) => adminSet.has(t));
  const isAdminBuilder = Boolean(input.isAdminBuilder) || grantsAdminTool;
  const rawRoles = Array.isArray(input.allowedRoles) ? input.allowedRoles.map((r) => String(r).trim()).filter(Boolean) : [];
  const allowedRoles = isAdminBuilder
    ? ['root', 'admin']
    : rawRoles.length
      ? [...new Set(rawRoles)]
      : ['ldx_employee', 'ldx_manager'];

  const mcpServers = [];
  for (const srv of Array.isArray(input.mcpServers) ? input.mcpServers : []) {
    if (!srv || typeof srv !== 'object') continue;
    const name = String(srv.name || '').trim();
    if (!USERNAME_RE.test(name)) throw failSchema('MCP_NAME_INVALID', `Tên kết nối MCP "${name}" không hợp lệ.`);
    mcpServers.push({
      name,
      url: validateMcpServerUrl(srv.url),
      useUserContext: srv.useUserContext !== false,
      enabled: srv.enabled !== false,
    });
  }

  const portalBindings = [...new Set((Array.isArray(input.portalBindings) ? input.portalBindings : []).map((s) => String(s).trim()).filter(Boolean))];
  const quickPrompts = [];
  for (const qp of Array.isArray(input.quickPrompts) ? input.quickPrompts : []) {
    if (!qp || typeof qp !== 'object') continue;
    const label = String(qp.label || '').trim();
    const prompt = String(qp.prompt || '').trim();
    if (label && prompt) quickPrompts.push({ label: label.slice(0, 80), prompt: prompt.slice(0, 1000) });
  }

  return {
    username,
    nickname: nickname.slice(0, 120),
    position: String(input.position || 'Trợ lý AI Doanh nghiệp').trim().slice(0, 120),
    departmentScope: String(input.departmentScope || 'general').trim().slice(0, 80),
    organizationId,
    avatar: String(input.avatar || 'nocobase-015-male').trim().slice(0, 80),
    bio: String(input.bio || '').trim().slice(0, 1000),
    greeting: String(input.greeting || '').trim().slice(0, 1000),
    systemPrompt: String(input.systemPrompt || '').trim().slice(0, 8000),
    llmService: String(input.llmService || 'local-9router').trim().slice(0, 80),
    modelName: String(input.modelName || 'ag/gemini-3.8-flash').trim().slice(0, 120),
    enabled: input.enabled !== false,
    isAdminBuilder,
    allowSubAgentDispatch: Boolean(input.allowSubAgentDispatch),
    allowedRoles,
    toolPermissions,
    mcpServers,
    portalBindings,
    quickPrompts,
    version: Math.max(1, Number(input.version) || 1),
  };
}

async function recordAiAuditLog(db, entry = {}) {
  const repo = db?.getRepository?.('latticeAiAuditLogs');
  if (!repo || typeof repo.create !== 'function') return null;
  const sanitizedArgs = redactPiiDeep(sanitizeAuditSummary(entry.argsSummary || {}));
  const redactedResult = entry.resultSummary ? redactPiiText(redactAuditText(String(entry.resultSummary))) : { text: null, count: 0 };
  const piiCount = entry.piiRedactedCount != null
    ? Math.max(0, Number(entry.piiRedactedCount) || 0)
    : (sanitizedArgs.count + redactedResult.count);
  const { promptTokens, completionTokens, totalTokens, tokenSource } = normalizeTokenUsage(entry);
  const baseValues = {
    actorUserId: entry.actorUserId ?? null,
    actorUsername: String(entry.actorUsername || '').slice(0, 100) || null,
    organizationId: String(entry.organizationId || '').slice(0, 80) || null,
    channel: String(entry.channel || 'ai-tool').slice(0, 40),
    aiEmployee: entry.aiEmployee ? String(entry.aiEmployee).slice(0, 80) : null,
    toolName: String(entry.toolName || 'unknown').slice(0, 120),
    argsSummary: sanitizedArgs.value,
    status: String(entry.status || 'allowed').slice(0, 32),
    durationMs: Math.max(0, Number(entry.durationMs) || 0),
    promptTokens,
    completionTokens,
    totalTokens,
    tokenSource,
    estimatedCostUsd: Math.max(0, Number(entry.estimatedCostUsd) || 0),
    piiRedactedCount: piiCount,
    errorCode: entry.errorCode ? String(entry.errorCode).slice(0, 80) : null,
    resultSummary: redactedResult.text ? redactedResult.text.slice(0, 1000) : null,
  };
  const txOpt = entry.transaction ? { transaction: entry.transaction } : {};
  const runWrite = () => runInRlsSavepoint(db, async () => {
    try {
      return await repo.create({ values: baseValues, ...txOpt });
    } catch {
      return runInRlsSavepoint(db, async () => {
        try {
          const { totalTokens: _tt, tokenSource: _ts, ...legacyValues } = baseValues;
          return await repo.create({ values: legacyValues, ...txOpt });
        } catch {
          return null;
        }
      });
    }
  });
  if (entry.transaction) {
    return runWrite();
  }
  const org = baseValues.organizationId;
  return org ? runWithTenantRls(db, org, runWrite) : runWithSystemRlsBypass(db, runWrite);
}

module.exports = {
  STARTER_AI_BLUEPRINTS,
  LEGACY_WORKFLOW_TASKS_TOOL,
  CANONICAL_WORKFLOW_TASKS_TOOL,
  normalizeToolPermissionsMap,
  aiProfiles,
  aiAuditLogs,
  uiSnapshots,
  aiQuotaUsage,
  aiApprovalQueue,
  validateMcpServerUrl,
  redactAuditText,
  sanitizeAuditSummary,
  validateAiProfilePayload,
  recordAiAuditLog,
  getEnvDefaultOrgId,
  resolveFirstActiveOrganizationId,
  resolveDefaultOrganizationId,
};
