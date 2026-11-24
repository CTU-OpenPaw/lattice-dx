/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

function stripDiacritics(input) {
  return String(input || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function norm(input) {
  return stripDiacritics(input).toLowerCase().replace(/\s+/g, ' ').trim();
}

const GRAPH_IMPACT_RE = /(phan\s+tich\s+anh\s+huong|truy\s+vet\s+(?:pha\s+he|nguon\s+goc|day\s+chuyen|anh\s+huong|tac\s+dong|lo\s+hang|don\s+hang)|tac\s+dong\s+(?:day\s+chuyen|lien\s+hoan|ha\s+nguon|thuong\s+nguon)|(?:nhung|cac)\s+(?:lo|don\s+hang|thiet\s+bi|su\s+co|epod)[^.?]{0,30}bi\s+anh\s+huong|neu\s+(?:kho\s+lanh|buong\s+lanh|thiet\s+bi|lo\s+hang|may\s+nen|xe\s+lanh)[^.?]{0,50}(?:hong|su\s+co|qua\s+nhiet|mat\s+dien)[^.?]{0,50}(?:anh\s+huong|lien\s+quan|lo|don)|anh\s+huong\s+day\s+chuyen|impact\s+analysis|graphrag)/;

function extractNegativeVietnameseNumber(utterance) {
  const rawLow = String(utterance || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  const explicitNeg = rawLow.match(/(?:(?<![\p{L}\p{N}_])(?:âm|trừ)\s+|(?<![a-z0-9])-\s*)(\d+(?:\.\d+)?)\s*(?:độ|°\s*c|°|c)?(?=\s|$|[,.;%)°]|độ)/iu);
  if (explicitNeg) return -Number(explicitNeg[1]);
  const masked = rawLow.replace(/(?<![\p{L}\p{N}_])độ\s+ẩm(?![\p{L}\p{N}_])/giu, 'do_am');
  const nForNeg = norm(masked);
  const asciiNeg = nForNeg.match(/(?:(?<!(?<!\bnhiet\s)\bdo\s)\bam\s+|\btru\s+|(?<![a-z0-9])-\s*)(\d+(?:\.\d+)?)\s*(?:do|°c|°|c)?\b/);
  if (asciiNeg) return -Number(asciiNeg[1]);
  return null;
}

function extractVietnameseThreshold(utterance) {
  const n = norm(utterance);
  const neg = extractNegativeVietnameseNumber(utterance);
  if (neg !== null) return neg;
  const pos = n.match(/(?:>|>=|vuot|cao hon|lon hon|tren|tu|duoi|thap hon|nho hon|nguong)\s*(\d+(?:\.\d+)?)\s*(?:do|°c|%|phut|h|gio)?\b/);
  if (pos) return Number(pos[1]);
  return null;
}

function extractVietnameseOperator(utterance) {
  const n = norm(utterance);
  if (/(?:<|thap hon|nho hon|duoi)\b/.test(n)) return 'lt';
  if (/(?:>|cao hon|lon hon|vuot|tren)\b/.test(n)) return 'gt';
  return 'gt';
}

function inferVietnameseTheme(utterance) {
  const n = norm(utterance);
  if (n.includes('canh bao do') || n.includes('bao dong') || n.includes('amber') || n.includes('vang cam') || n.includes('khan cap')) {
    return 'amber-alert';
  }
  if (n.includes('sang') || n.includes('clean') || n.includes('toi gian') || n.includes('nhe nhang')) {
    return 'clean-light';
  }
  if (n.includes('emerald') || n.includes('xanh la') || n.includes('van hanh xanh')) {
    return 'emerald-ops';
  }
  if (n.includes('royal') || n.includes('indigo') || n.includes('tim')) {
    return 'royal-indigo';
  }
  return 'industrial-cockpit';
}

function inferVietnameseWidgetType(utterance) {
  const n = norm(utterance);
  if (n.includes('bieu do duong') || n.includes('lich su') || n.includes('theo thoi gian') || n.includes('timeseries') || n.includes('24h') || n.includes('xu huong')) {
    return 'timeseries-line';
  }
  if (n.includes('nhiet ke') || n.includes('nhiet do') || n.includes('buong lanh') || n.includes('kho lanh')) {
    return 'thermometer';
  }
  if (n.includes('pipeline') || n.includes('quy trinh tung buoc') || n.includes('giai doan')) {
    return 'stage-pipeline';
  }
  if (n.includes('dong ho') || n.includes('gauge')) {
    return 'gauge';
  }
  if (n.includes('phan bo') || n.includes('bieu do cot') || n.includes('ti le') || n.includes('ty le')) {
    return 'distribution-bars';
  }
  if (n.includes('ma tran') || n.includes('matrix') || n.includes('bang trang thai')) {
    return 'status-matrix';
  }
  if (n.includes('nut thao tac') || n.includes('nut bam') || n.includes('hanh dong nhanh')) {
    return 'quick-actions';
  }
  return 'gauge';
}

function extractPlaceBesideTitle(utterance) {
  const raw = String(utterance || '');
  const m = raw.match(/(?:đặt|xếp|gắn|chèn|nằm)?\s*(?:ngang\s+cạnh|bên\s+cạnh|song\s+song\s+với|song\s+song|ngang|cạnh)\s+(?:khối|phần|card|mục)?\s*["“]?([^,.;"\n]{2,40})/i);
  if (!m || !m[1]) return null;
  let candidate = m[1].trim()
    .replace(/^(?:phần|khối|mục|bảng)\s+/i, '')
    .replace(/\s+(?:giúp tôi|nhé|nha|với|trên trang này).*$/i, '')
    .trim();
  if (!candidate) return null;
  return candidate.charAt(0).toUpperCase() + candidate.slice(1);
}

function extractVietnameseRoleTitle(utterance) {
  const raw = String(utterance || '');
  const patterns = [
    /(?:cho\s+(?:đội|nhóm|bộ phận|ban|chức danh|vai trò))\s+([^,.;\n]{3,60}?)(?=\s+(?:và|với|nhưng|khóa|khoá|chỉ|ở|tại|$))/i,
    /(?:tạo|lập|thêm)\s+(?:vai trò|nhóm quyền)(?:\s+mới)?\s+(?:là|tên|gọi là)?\s*([^,.;\n]{3,60}?)(?=\s+(?:và|với|nhưng|khóa|khoá|chỉ|ở|tại|$))/i,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m && m[1]) {
      return m[1].trim().replace(/^["“']|["”']$/g, '');
    }
  }
  return 'Nhân sự Chuyên trách Mới';
}

function extractVietnameseLockedFields(utterance) {
  const raw = String(utterance || '');
  const m = raw.match(/(?:khóa|khoá|chặn sửa|không cho sửa|chỉ đọc)\s+(?:các\s+)?(?:cột|trường|ô)?\s*([^.;\n]+)/i);
  if (!m || !m[1]) return [];
  return m[1]
    .split(/\s*(?:,|và|cùng|cùng với|&)\s*/i)
    .map((s) => s.replace(/^(?:cột|trường|ô)\s+/i, '').trim())
    .map((s) => s.replace(/\s+(?:giúp tôi|nhé|nha|trên trang này).*$/i, '').trim())
    .filter((s) => s.length >= 2 && s.length <= 60);
}

function inferPortalFromUtterance(utterance, fallback = 'services') {
  const n = norm(utterance);
  if (n.includes('van tai') || n.includes('logistics') || n.includes('don hang') || n.includes('giao hang') || n.includes('tai xe')) return 'logistics';
  if (n.includes('su co') || n.includes('iot') || n.includes('cbm') || n.includes('kho lanh') || n.includes('nhiet do') || n.includes('bao dong')) return 'incidents';
  if (n.includes('mua sam') || n.includes('nha cung cap') || n.includes('procurement') || n.includes('tai san')) return 'procurement';
  if (n.includes('hr') || n.includes('nghi phep') || n.includes('dich vu') || n.includes('phieu ho tro')) return 'services';
  return String(fallback || 'services').trim().toLowerCase() || 'services';
}

function detectUnsafeOrInjection(n) {
  const promptInjection = /(bo qua\s+(?:tat ca|moi)?\s*(?:huong dan|kiem tra|quyen|rbac|acl|phe duyet|hitl|bao mat)|bo qua\s+(?:buoc\s+)?(?:kiem\s+tra\s+)?(?:quyen\s+)?hitl|ignore\s+(?:all\s+)?previous|system\s+prompt|jailbreak|bypass\s+(?:rbac|acl|auth|hitl|quyen|phe duyet|bao mat)|vuot\s+quyen|vo\s+hieu\s+hoa\s+(?:audit|nhat\s+ky|rls|bao\s+mat|hitl|phe\s+duyet)|in\s+ra\s+[^\n]{0,40}?(?:mat\s+khau|api\s*key|token|bi\s+mat|secret|credential|private\s*key)|tiet\s+lo\s+[^\n]{0,40}?(?:mat\s+khau|bi\s+mat|token|api\s*key|secret|private\s*key|credential)|doc\s+(?:bien\s+moi\s+truong|\.env|process\.env)|xuat\s+toan\s+bo\s+(?:api\s*key|token|mat\s+khau|secret(?:\s*key)?|bang\s+users|du\s+lieu)|(?:xem|doc|xuat|lay)\s+(?:toan\s+bo\s+)?(?:du\s+lieu|don\s+hang|lo\s+hang|su\s+co|tai\s+lieu|bang)[^\n]{0,30}?(?:to\s+chuc|cong\s+ty|tenant|org)\s+khac|(?:doc|xem|sua|xoa|tao|ghi|cap\s+nhat|truy\s+cap)\s+(?:bang|table|collection)?\s*(?:latticeconnectors|latticeapikeys|latticepkikeys|latticecryptoledger|latticeautomationrules|latticeautomationruns|rolesusers)\b|xem\s+luong\s+toan\s+cong\s+ty|cross[\s-]?tenant|tu\s+(?:phe\s+duyet|duyet)\s+(?:yeu\s+cau|don|phieu|ho\s+so|run)\s+(?:cua\s+)?(?:chinh\s+minh|toi)|drop\s+table|truncate\s+table|delete\s+from|union\s+select|xoa\s+toan\s+bo\s+bang|mo\s+toan\s+bo\s+bang|gan\s+quyen\s+root|cap\s+quyen\s+(?:root|admin\s+he\s+thong)|__proto__|constructor\s*\.\s*prototype|\beval\s*\(|\bnew\s+Function\s*\()/;
  if (promptInjection.test(n)) {
    return {
      refused: true,
      reason: 'Yêu cầu vi phạm chính sách bảo mật (injection, lộ bí mật, vượt tenant hoặc leo thang đặc quyền hệ thống).',
    };
  }
  return null;
}

function extractGraphImpactArgs(raw, n) {
  const cleanRaw = stripDiacritics(raw);
  const codeRules = [
    { re: /\b(LOT-[A-Z0-9-]+)\b/, collection: 'latticeStockLots' },
    { re: /\b(ORD-[A-Z0-9-]+)\b/, collection: 'latticeOrders' },
    { re: /\b((?:INC|ALM)-[A-Z0-9-]+)\b/, collection: 'latticeIncidentCases' },
    { re: /\b(EPOD-[A-Z0-9-]+)\b/, collection: 'latticeEpodRecords' },
    { re: /\b((?:AST|COLD-ROOM|KHO)-[A-Z0-9-]+)\b/, collection: 'latticeAssets' },
    { re: /(urn:ngsi-ld:[^\s,;?]+)/, collection: 'latticeAssets' },
  ];
  let collection = null;
  let recordCode = null;
  for (const rule of codeRules) {
    const m = cleanRaw.match(rule.re);
    if (m && m[1]) {
      collection = rule.collection;
      recordCode = m[1].trim();
      break;
    }
  }
  if (!collection) {
    if (/(lo\s+(?:hang|ton\s+kho|vaccine|duoc|lanh)|\blot\b)/.test(n)) collection = 'latticeStockLots';
    else if (/(don\s+hang|don\s+van\s+chuyen)/.test(n)) collection = 'latticeOrders';
    else if (/(epod|bien\s+ban\s+giao\s+nhan)/.test(n)) collection = 'latticeEpodRecords';
    else if (/(kho\s+lanh|buong\s+lanh|may\s+nen|thiet\s+bi|tai\s+san)/.test(n)) collection = 'latticeAssets';
    else if (/(su\s+co|canh\s+bao|bao\s+dong)/.test(n)) collection = 'latticeIncidentCases';
    else collection = 'latticeAssets';
  }
  if (!recordCode) {
    const shortMatch = cleanRaw.match(/\b(?:kho\s+lanh|buong\s+lanh|may\s+nen|thiet\s+bi)\s+([A-Z0-9]{1,12}-[A-Z0-9-]{1,16}|[A-Z][A-Z0-9-]{0,16}\d[A-Z0-9-]{0,8})\b/);
    if (shortMatch && shortMatch[1]) recordCode = shortMatch[1].trim();
  }
  const includeTelemetry = /(nhiet\s+do|telemetry|cam\s+bien|do\s+am)/.test(n);
  const maxDepth = /(toan\s+bo\s+chuoi|3\s+tang|sau\s+3|epod|khach\s+hang|ha\s+nguon)/.test(n) ? 3 : 2;
  return {
    collection,
    ...(recordCode ? { recordCode } : {}),
    maxDepth,
    ...(includeTelemetry ? { includeTelemetry: true } : {}),
  };
}

function extractAutomationRuleKey(raw) {
  const clean = stripDiacritics(raw).trim();
  const explicit = clean.match(/\bruleKey\s*[:=]\s*([a-z0-9][a-z0-9_-]{1,62})\b/i);
  if (explicit && explicit[1]) return explicit[1].toLowerCase();
  const autoKey = clean.match(/\b(auto_[a-z0-9][a-z0-9_-]{1,60})\b/i);
  if (autoKey && autoKey[1]) return autoKey[1].toLowerCase();
  const ruleNamed = clean.match(/\b(?:rule|luat|automation|flow|luong)\s+([a-z0-9]+(?:_[a-z0-9-]+)+)\b/i);
  if (ruleNamed && ruleNamed[1]) return ruleNamed[1].toLowerCase();
  return null;
}

function extractAutomationRunUid(raw) {
  const clean = stripDiacritics(raw).trim();
  const explicit = clean.match(/\brunUid\s*[:=]\s*([a-zA-Z0-9_-]{3,80})\b/i);
  if (explicit && explicit[1]) return explicit[1];
  const runPrefixed = clean.match(/\b(run_[a-zA-Z0-9_-]{2,76})\b/i);
  if (runPrefixed && runPrefixed[1]) return runPrefixed[1];
  const afterVerb = clean.match(/\b(?:phe\s+duyet|duyet|tu\s+choi|resume|tiep\s+tuc)\s+(?:run|luot\s+chay|phien\s+chay)\s+([a-zA-Z0-9_-]{3,80})\b/i);
  if (afterVerb && afterVerb[1]) return afterVerb[1];
  return null;
}

function extractAutomationNodeId(raw) {
  const clean = stripDiacritics(raw).trim();
  const explicit = clean.match(/\bnodeId\s*[:=]\s*([a-zA-Z0-9_.-]{2,80})\b/i);
  if (explicit && explicit[1]) return explicit[1];
  const afterNode = clean.match(/\b(?:chay\s+thu|test|kiem\s+thu|sua|doi|cap\s+nhat)\s+node\s+(?!ai\b|llm\b|phe\s+duyet\b|approval\b)([a-zA-Z][a-zA-Z0-9_.-]{1,60})\b/i);
  if (afterNode && afterNode[1]) return afterNode[1];
  return null;
}

function extractAutomationTargetNode(raw, nInput) {
  const n = nInput ? String(nInput) : norm(raw);
  const stepColon = n.match(/\bsteps?\s*[:.]\s*(\d+)\b/);
  if (stepColon) return `step:${stepColon[1]}`;
  const buoc = n.match(/\b(?:buoc|hanh dong)(?:\s+thu)?\s*(\d+)\b/);
  if (buoc) {
    const idx = Number(buoc[1]);
    return `step:${idx >= 1 ? idx - 1 : 0}`;
  }
  const explicitNode = extractAutomationNodeId(raw);
  if (explicitNode) return explicitNode;
  if (/(?:cooldown|chong lap|gian cach)/.test(n)) return 'cooldown';
  if (/(?:\bdmn\b|bang quyet dinh)/.test(n)) return 'dmn';
  if (/(?:\btrigger\b|su kien kich hoat)/.test(n)) return 'trigger';
  if (/(?:them|bo sung|gan)\s+(?:[^\n]{0,20}\s)?(?:buoc|node)\b/.test(n)) return 'actions';
  if (/(?:bo loc|\bfilter\b|dieu kien|nguong|nhanh)/.test(n)) return 'filter';
  return null;
}

function extractAutomationSampleEvent(raw, n) {
  const cleanRaw = stripDiacritics(raw);
  const sample = {};
  const thr = extractVietnameseThreshold(raw);
  const exactNum = n.match(/(?:tempc|nhiet do)\s*(?:=|la|:)?\s*(-?\d+(?:\.\d+)?)/i);
  const negExact = extractNegativeVietnameseNumber(raw);
  const humMatch = n.match(/(?<!\bnhiet\s)\bdo am\s*(?:=|la|:|vuot|cao hon|lon hon|tren|duoi|thap hon|nho hon|nguong|>|>=|<|<=)?\s*(\d+(?:\.\d+)?)\s*%?/);
  if (humMatch) sample.humidity = Number(humMatch[1]);
  if (exactNum) sample.tempC = Number(exactNum[1]);
  else if (negExact !== null) sample.tempC = negExact;
  else if (thr !== null && !(humMatch && !/(?:nhiet do|tempc|temperature)/.test(n))) sample.tempC = thr;
  const assetMatch = cleanRaw.match(/\b((?:COLD-ROOM|AST|CHILLER|ROOM|DEVICE)-[A-Z0-9-]{1,32})\b/);
  if (assetMatch && assetMatch[1]) {
    sample.deviceKey = assetMatch[1];
    sample.assetCode = assetMatch[1];
  }
  if (/\b(?:critical|nghiem trong|khan cap)\b/.test(n)) sample.severity = 'critical';
  else if (/\b(?:high|cao)\b/.test(n)) sample.severity = 'high';
  else if (/\b(?:warning|canh bao|nhe|trung binh)\b/.test(n)) sample.severity = 'warning';
  return sample;
}

function parseVietnameseNaturalIntent(utterance, { isAdmin = false, portalSlug = 'services' } = {}) {
  const raw = String(utterance || '').trim();
  const n = norm(raw);
  const targetPortal = inferPortalFromUtterance(raw, portalSlug);

  if (!n) {
    return { intent: 'UNKNOWN', refused: true, reason: 'Chưa có nội dung yêu cầu.', toolName: null, args: {} };
  }

  const securityHit = detectUnsafeOrInjection(n);
  if (securityHit) {
    return { intent: 'REFUSE_FORBIDDEN', refused: true, reason: securityHit.reason, toolName: null, args: {} };
  }

  const requireAdminOrRefuse = (intentName) => {
    if (!isAdmin) {
      return {
        intent: 'REFUSE_FORBIDDEN',
        refused: true,
        reason: `Thao tác quản trị (${intentName}) chỉ dành cho Quản trị viên hệ thống.`,
        toolName: null,
        args: {},
      };
    }
    return null;
  };

  // 1. Rollback Time-Machine
  if (/(hoan tac|quay lai\s+bo\s+cuc|khoi phuc\s+(?:giao dien|trang|bo cuc)|rollback|tro ve\s+ban\s+dau)/.test(n)) {
    const denied = requireAdminOrRefuse('rollback');
    if (denied) return denied;
    return {
      intent: 'ROLLBACK_LAYOUT',
      refused: false,
      toolName: 'dxos_snapshot_or_rollback_page',
      args: { action: 'rollback', portalSlug: targetPortal },
    };
  }

  // 2. Role Workspace Provisioning
  if (/(tao\s+vai\s+tro|lap\s+nhom\s+quyen|them\s+vai\s+tro|phan\s+quyen\s+(?:moi|rieng)|chuc\s+danh\s+moi)/.test(n)) {
    const denied = requireAdminOrRefuse('provision_role');
    if (denied) return denied;
    return {
      intent: 'PROVISION_ROLE',
      refused: false,
      toolName: 'dxos_provision_role_workspace',
      args: {
        roleTitle: extractVietnameseRoleTitle(raw),
        portalSlug: targetPortal,
        lockedFields: extractVietnameseLockedFields(raw),
        dryRun: false,
      },
    };
  }

  // 3. Recommend / Inspect Page Blocks
  if (/(goi y\s+(?:xem|bo cuc|khoi|block|nang cap)|de xuat\s+(?:khoi|bo cuc|dashboard)|xem\s+(?:trang nay|cau truc).*(?:khoi nao|block nao|gi)|trang\s+nay\s+dang\s+co\s+nhung\s+khoi\s+nao)/.test(n)) {
    const denied = requireAdminOrRefuse('recommend_blueprint');
    if (denied) return denied;
    const isList = n.includes('dang co') || n.includes('liet ke') || n.includes('xem cac khoi');
    return {
      intent: isList ? 'INSPECT_PAGE_BLOCKS' : 'RECOMMEND_BLUEPRINT',
      refused: false,
      toolName: isList ? 'dxos_compose_page_blocks' : 'dxos_recommend_page_blueprint',
      args: isList ? { action: 'listBlocks', portalSlug: targetPortal } : { portalSlug: targetPortal },
    };
  }

  const isGraphImpact = GRAPH_IMPACT_RE.test(n);

  // 3.4. Direct n8n Service & Vault Connector Bridge (List / Test / Invoke n8n) — Admin only
  const isFlowDraftPrompt = /(?:^|\s)(?:tao|dung|lap|thiet\s+ke|xay\s+dung)\s+(?:moi\s+)?(?:automation|flow|dag|luong\s+tu\s+dong|quy\s+trinh)\b/.test(n);
  if (!isGraphImpact && !isFlowDraftPrompt) {
    const connMatch = raw.match(/\b(n8n-[a-z0-9_-]{2,60}|erp-webhook-sync)\b/i);
    const webhookPathMatch = raw.match(/(\/webhook\/[a-z0-9/_-]{2,120})/i);
    const extractedConn = connMatch && connMatch[1] ? connMatch[1].trim().toLowerCase() : null;
    const extractedPath = webhookPathMatch && webhookPathMatch[1] ? webhookPathMatch[1].trim() : null;

    if (/(?:liet\s+ke|xem\s+danh\s+sach|danh\s+sach)\s+(?:cac\s+)?(?:ket\s+noi\s+n8n|n8n|connector)\b/.test(n)) {
      const denied = requireAdminOrRefuse('n8n_connector_list');
      if (denied) return denied;
      return {
        intent: 'N8N_LIST_CONNECTORS',
        refused: false,
        toolName: 'dxos_configure_workflow',
        args: { operation: 'listConnectors', ...(n.includes('n8n') ? { connectorType: 'n8n' } : {}) },
      };
    }
    if (/(?:kiem\s+tra|test|ping)\s+(?:ket\s+noi\s+)?(?:n8n|connector)\b/.test(n)) {
      const denied = requireAdminOrRefuse('n8n_connector_test');
      if (denied) return denied;
      return {
        intent: 'N8N_TEST_CONNECTOR',
        refused: false,
        toolName: 'dxos_configure_workflow',
        args: { operation: 'testConnector', ...(extractedConn ? { connectorKey: extractedConn } : {}) },
      };
    }
    if (/(?:goi\s+(?:truc\s+tiep\s+)?(?:luong\s+)?n8n|chay\s+(?:luong\s+)?n8n|kich\s+hoat\s+(?:luong\s+)?n8n|day\s+sang\s+n8n|invoke\s+n8n)/.test(n)) {
      const denied = requireAdminOrRefuse('n8n_invoke');
      if (denied) return denied;
      return {
        intent: 'N8N_INVOKE',
        refused: false,
        toolName: 'dxos_configure_workflow',
        args: {
          operation: 'invokeN8n',
          ...(extractedConn ? { connectorKey: extractedConn } : {}),
          ...(extractedPath ? { webhookPath: extractedPath } : {}),
          payload: { goal: raw },
        },
      };
    }
  }

  // 3.5. DX-OS Flow Architect (Suggest / Test / Patch / Draft / Resume / Fix Error) — Admin only
  const runUid = extractAutomationRunUid(raw);
  const preExtractedRuleKey = extractAutomationRuleKey(raw);
  const hasFixErrorSignal = /(?:sua\s+loi\s+(?:lan\s+chay|flow|automation|rule|luong)|fix\s+loi\s+(?:flow|automation|rule|lan\s+chay|luong)|khac\s+phuc\s+loi\s+(?:lan\s+chay|flow|automation|luong))/.test(n);
  const hasResumeSignal = !hasFixErrorSignal && (
    Boolean(runUid && /(phe\s+duyet|duyet|tu\s+choi|approve|approved|reject|rejected|resume|tiep\s+tuc)/.test(n))
    || /(?:phe\s+duyet|duyet|tu\s+choi)\s+(?:run|luot\s+chay|phien\s+chay)\b|\bresume\s+(?:run|flow|automation)\b/.test(n)
  );
  const hasAutomationTopic = !isGraphImpact && (
    hasResumeSignal
    || hasFixErrorSignal
    || Boolean(preExtractedRuleKey)
    || /(?:automation|luong\s+tu\s+dong|tu\s+dong\s+hoa|rule\s+tu\s+dong|quy\s+trinh\s+tu\s+dong|\bauto_[a-z0-9][a-z0-9_-]*\b|(?:toi\s+uu|va|sua|doi|cap\s+nhat|chay\s+thu|mo\s+phong|test)\s+(?:rule|luat|luong|flow|node)\b|\bflow\b|\bdag\b|\bnode\s+(?:ai|llm)\b|\bcron\b|dinh\s+ky\s+cron|moi\s+sang\s+\d+h|inbound\s+webhook|(?:nhan|tao|dung|thiet\s+ke|cau\s+hinh)\s+(?:inbound\s+)?webhook|re\s+nhanh\s+song\s+song|dung\s+llm\s+tom\s+tat)/.test(n)
  );
  if (hasAutomationTopic) {
    const ruleKey = preExtractedRuleKey;
    const nodeId = extractAutomationNodeId(raw);
    const isList = /(?:liet\s+ke|xem\s+danh\s+sach)\s+(?:cac\s+)?(?:automation|flow|luong\s+tu\s+dong|rule\s+tu\s+dong)/.test(n);
    const isSuggest = /(goi y toi uu|de xuat cai tien|toi uu(?:\s+(?:automation|rule|luong|flow|dag))?|phan tich\s+(?:automation|rule|luong|flow|dag)|kiem tra\s+(?:automation|rule|luong|flow|dag))/.test(n);
    const isTest = /(mo phong|dry[\s-]?run|chay thu|test\s+node|kiem\s+thu\s+node)/.test(n);
    const isDraftExplicit = /(?:^|\s)(?:tao|dung|lap|thiet ke|xay dung)\s+(?:moi\s+)?(?:automation|flow|dag|luong tu dong|quy trinh tu dong|rule tu dong|tu dong hoa|lich\s+(?:chay\s+)?cron)\b/.test(n);
    const isPatchVerb = /(?:doi|sua|va|chinh|cap nhat|xoa|gan)\s+(?:[^\n]{0,24}?\s)?(?:buoc(?:\s+\d+)?|step(?:\s*:\s*\d+)?|node(?:\s+[a-z0-9_.-]+)?|dieu kien|nguong|nhiet do|cooldown|dmn|nhanh|bo loc|filter|trigger)/.test(n)
      || (/(?:them|bo sung|gan)\s+(?:[^\n]{0,20}?\s)?(?:buoc|node|dieu kien|cooldown|nhanh|bo loc)/.test(n) && (Boolean(ruleKey) || /(?:cua|cho|trong|vao)\s+(?:automation|rule|luong|flow)\b/.test(n)));
    const isPatch = isPatchVerb && (!isDraftExplicit || Boolean(ruleKey));

    if (hasFixErrorSignal) {
      const denied = requireAdminOrRefuse('automation_architect');
      if (denied) return denied;
      const targetNode = extractAutomationTargetNode(raw, n);
      return {
        intent: 'AUTOMATION_FIX_ERROR',
        refused: false,
        toolName: 'dxos_configure_workflow',
        args: {
          operation: 'patchAutomation',
          mode: 'fix_error',
          ...(ruleKey ? { ruleKey } : {}),
          ...(runUid ? { runTrace: { runUid } } : {}),
          ...(targetNode ? { targetNode } : {}),
          goal: raw,
          apply: false,
        },
      };
    }

    if (hasResumeSignal) {
      const denied = requireAdminOrRefuse('automation_architect');
      if (denied) return denied;
      const decision = /(tu\s+choi|reject|rejected|khong\s+duyet)/.test(n) ? 'rejected' : 'approved';
      return {
        intent: 'AUTOMATION_RESUME',
        refused: false,
        toolName: 'dxos_configure_workflow',
        args: {
          operation: 'resumeAutomation',
          ...(runUid ? { runUid } : {}),
          decision,
          payload: { note: raw },
        },
      };
    }

    if (isList && !isDraftExplicit && !isPatch && !isSuggest && !isTest) {
      const denied = requireAdminOrRefuse('automation_architect');
      if (denied) return denied;
      return {
        intent: 'AUTOMATION_LIST',
        refused: false,
        toolName: 'dxos_configure_workflow',
        args: { operation: 'listAutomations' },
      };
    }

    if (isSuggest) {
      const denied = requireAdminOrRefuse('automation_architect');
      if (denied) return denied;
      return {
        intent: 'AUTOMATION_SUGGEST',
        refused: false,
        toolName: 'dxos_configure_workflow',
        args: {
          operation: 'suggestAutomation',
          ...(ruleKey ? { ruleKey } : {}),
          goal: raw,
        },
      };
    }

    if (isTest && !isDraftExplicit) {
      const denied = requireAdminOrRefuse('automation_architect');
      if (denied) return denied;
      return {
        intent: 'AUTOMATION_TEST',
        refused: false,
        toolName: 'dxos_configure_workflow',
        args: {
          operation: 'testAutomation',
          ...(ruleKey ? { ruleKey } : {}),
          ...(nodeId ? { nodeId } : {}),
          sampleEvent: extractAutomationSampleEvent(raw, n),
          goal: raw,
        },
      };
    }

    if (isPatch) {
      const denied = requireAdminOrRefuse('automation_architect');
      if (denied) return denied;
      const targetNode = extractAutomationTargetNode(raw, n);
      return {
        intent: 'AUTOMATION_PATCH',
        refused: false,
        toolName: 'dxos_configure_workflow',
        args: {
          operation: 'patchAutomation',
          ...(ruleKey ? { ruleKey } : {}),
          ...(nodeId ? { nodeId } : {}),
          ...(targetNode ? { targetNode } : {}),
          goal: raw,
          apply: false,
        },
      };
    }

    if (
      isDraftExplicit
      || /(?:\btao\b|\bdung\b|\blap\b|\bthiet ke\b|\bnhan\b).*(?:automation|luong tu dong|tu dong hoa|rule tu dong|\bflow\b|\bdag\b|webhook|cron)/.test(n)
      || /\bcron\b|dinh\s+ky\s+cron|moi\s+sang\s+\d+h|inbound\s+webhook|dung\s+llm\s+tom\s+tat/.test(n)
    ) {
      const denied = requireAdminOrRefuse('automation_architect');
      if (denied) return denied;
      return {
        intent: 'AUTOMATION_DRAFT',
        refused: false,
        toolName: 'dxos_configure_workflow',
        args: {
          operation: 'draftAutomation',
          ...(ruleKey ? { ruleKey } : {}),
          goal: raw,
          apply: false,
        },
      };
    }
  }

  // 4. Design Creative Block (thermometer, timeseries-line, gauge, pipeline, alerts)
  if (/(them\s+(?:khoi|block|nhiet ke|dong ho|bieu do|canh bao|pipeline|ma tran)|ve\s+bieu\s+do|thiet\s+ke\s+(?:khoi|bang\s+chi\s+so|dashboard)|gan\s+(?:nhiet ke|dong ho|bieu do|canh bao)|dat\s+ngang|canh\s+bao\s+do)/.test(n)) {
    const denied = requireAdminOrRefuse('design_creative_block');
    if (denied) return denied;
    const widgetType = inferVietnameseWidgetType(raw);
    const threshold = extractVietnameseThreshold(raw);
    const operator = extractVietnameseOperator(raw);
    const theme = inferVietnameseTheme(raw);
    const placeBesideTitle = extractPlaceBesideTitle(raw);
    return {
      intent: 'DESIGN_CREATIVE_BLOCK',
      refused: false,
      toolName: 'dxos_design_creative_block',
      args: {
        portalSlug: targetPortal,
        widgetType,
        theme,
        ...(threshold !== null ? { threshold, operator } : {}),
        ...(placeBesideTitle ? { placeBesideTitle } : {}),
        goal: raw,
        dryRun: false,
      },
    };
  }

  // 5. Alarm Acknowledge / Clear (OT Incident Ops)
  if (/(xac nhan\s+(?:tiep\s+nhan|nhan\s+xu\s+ly)?\s*(?:canh\s+bao|su\s+co|bao\s+dong)|ack\s+alarm|dong\s+(?:canh\s+bao|bao\s+dong)|tat\s+bao\s+dong|giai\s+toa\s+canh\s+bao|clear\s+alarm)/.test(n)) {
    const isClear = /(dong\s+(?:canh\s+bao|bao\s+dong)|tat\s+bao\s+dong|giai\s+toa|clear|da\s+khac\s+phuc\s+xong)/.test(n);
    const alarmCodeMatch = stripDiacritics(raw).match(/\b((?:ALM|INC)-[A-Z0-9-]{1,40})\b/);
    const alarmCode = alarmCodeMatch && alarmCodeMatch[1] ? alarmCodeMatch[1].trim() : null;
    return {
      intent: isClear ? 'ALARM_CLEAR' : 'ALARM_ACK',
      refused: false,
      toolName: 'dxos_alarm_action',
      args: {
        action: isClear ? 'clear' : 'ack',
        ...(alarmCode ? { alarmCode } : {}),
        note: raw,
      },
    };
  }

  // 6. GraphRAG Impact & Lineage Analysis (before Radar & broad RAG Search)
  if (isGraphImpact) {
    return {
      intent: 'GRAPH_IMPACT_ANALYSIS',
      refused: false,
      toolName: 'dxos_graph_impact_analysis',
      args: extractGraphImpactArgs(raw, n),
    };
  }

  // 7. Cross-department Radar & Orchestration (check before personal tasks if asking company-wide)
  if (/(radar|diem\s+nghen|tong\s+hop\s+(?:toan\s+cong\s+ty|toan\s+he\s+thong|6\s+phan\s+he|lien\s+phong\s+ban)|dieu\s+phoi\s+lien|tong\s+quan\s+tinh\s+hinh\s+van\s+hanh)/.test(n)) {
    return {
      intent: 'ENTERPRISE_RADAR',
      refused: false,
      toolName: 'dxos_orchestrate_enterprise_case',
      args: { mode: 'radar', query: raw },
    };
  }

  // 7. My Workflow Tasks & Approvals
  if (/(viec\s+(?:can\s+duyet|cua\s+toi|toi\s+can\s+xu\s+ly|ton\s+dong)|tac\s+vu\s+(?:cho\s+duyet|cua\s+toi)|danh\s+sach\s+(?:cong\s+viec|duyet)|(?:cho\s+(?:toi\s+)?)?phe\s+duyet(?:\s+(?:phieu|don|yeu\s+cau))?|cho\s+toi\s+duyet|toi\s+co\s+(?:bao\s+nhieu|viec\s+gi))/.test(n)) {
    return {
      intent: 'MY_TASKS',
      refused: false,
      toolName: 'dxos_my_workflow_tasks',
      args: { action: 'list' },
    };
  }

  // 8. Enterprise Knowledge & Record Search (P.A.R.A. + Business Collections)
  if (/(tim|tra\s+cuu|xem|kiem\s+tra|hoi|doc|co\s+(?:tai\s+lieu|quy\s+trinh|sop|don\s+hang|su\s+co|phieu|tai\s+san|du\s+lieu)|huong\s+dan|lich\s+su|nhiet\s+do\s+(?:hien\s+tai|kho))/.test(n)) {
    return {
      intent: 'SEARCH_CONTEXT',
      refused: false,
      toolName: 'dxos_search_enterprise_context',
      args: { query: raw, limit: 8 },
    };
  }

  return {
    intent: 'SEARCH_CONTEXT',
    refused: false,
    toolName: 'dxos_search_enterprise_context',
    args: { query: raw, limit: 8 },
  };
}

module.exports = {
  stripDiacritics,
  extractVietnameseThreshold,
  extractVietnameseOperator,
  inferVietnameseTheme,
  inferVietnameseWidgetType,
  extractPlaceBesideTitle,
  extractVietnameseRoleTitle,
  extractVietnameseLockedFields,
  extractAutomationRuleKey,
  extractAutomationRunUid,
  extractAutomationNodeId,
  extractAutomationTargetNode,
  parseVietnameseNaturalIntent,
};
