/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const SOURCE_PATH = path.join(PLUGIN_ROOT, 'src/client/public-form-builder.js');
const HEADER_SCRIPT = path.resolve(PLUGIN_ROOT, '../../../scripts/source-headers.mjs');

function collectNodes(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectNodes(item, pred, out);
    return out;
  }
  if (pred(node)) out.push(node);
  if (Array.isArray(node.children)) collectNodes(node.children, pred, out);
  return out;
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && Array.isArray(node.children)) return textOf(node.children);
  return '';
}

function createReactHarness() {
  const statesByComponent = new WeakMap();
  const effectsByComponent = new WeakMap();
  const memosByComponent = new WeakMap();
  let currentComponent = null;
  let stateIdx = 0;
  let effectIdx = 0;
  let memoIdx = 0;
  const pendingEffects = [];

  function getBucket(map, comp) {
    let arr = map.get(comp);
    if (!arr) {
      arr = [];
      map.set(comp, arr);
    }
    return arr;
  }

  const React = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      const flat = [];
      for (const c of children) {
        if (Array.isArray(c)) flat.push(...c);
        else flat.push(c);
      }
      return { type, props: props || {}, children: flat };
    },
    useState(init) {
      const comp = currentComponent;
      const bucket = getBucket(statesByComponent, comp);
      const idx = stateIdx++;
      if (bucket.length <= idx) {
        bucket[idx] = typeof init === 'function' ? init() : init;
      }
      const setState = (next) => {
        bucket[idx] = typeof next === 'function' ? next(bucket[idx]) : next;
      };
      return [bucket[idx], setState];
    },
    useEffect(fn, deps) {
      const comp = currentComponent;
      const bucket = getBucket(effectsByComponent, comp);
      const idx = effectIdx++;
      const prev = bucket[idx];
      const changed = !prev || !Array.isArray(deps) || deps.length !== prev.deps?.length || deps.some((d, i) => !Object.is(d, prev.deps[i]));
      if (changed) {
        bucket[idx] = { deps: Array.isArray(deps) ? deps.slice() : null };
        pendingEffects.push(fn);
      }
    },
    useCallback(fn) {
      return fn;
    },
    useMemo(fn, deps) {
      const comp = currentComponent;
      const bucket = getBucket(memosByComponent, comp);
      const idx = memoIdx++;
      const prev = bucket[idx];
      const changed = !prev || !Array.isArray(deps) || deps.length !== prev.deps?.length || deps.some((d, i) => !Object.is(d, prev.deps[i]));
      if (changed) {
        bucket[idx] = { deps: Array.isArray(deps) ? deps.slice() : null, value: fn() };
      }
      return bucket[idx].value;
    },
  };

  function renderNode(node) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(renderNode);
    if (typeof node.type === 'function') {
      const prevComp = currentComponent;
      const prevS = stateIdx;
      const prevE = effectIdx;
      const prevM = memoIdx;
      currentComponent = node.type;
      stateIdx = 0;
      effectIdx = 0;
      memoIdx = 0;
      let out;
      try {
        out = node.type(node.props || {});
      } finally {
        currentComponent = prevComp;
        stateIdx = prevS;
        effectIdx = prevE;
        memoIdx = prevM;
      }
      return renderNode(out);
    }
    if (Array.isArray(node.children)) {
      return { ...node, children: node.children.map(renderNode) };
    }
    return node;
  }

  async function mountAndFlush(ComponentFn, props = {}) {
    let tree = renderNode(React.createElement(ComponentFn, props));
    for (let pass = 0; pass < 5 && pendingEffects.length > 0; pass += 1) {
      const batch = pendingEffects.splice(0, pendingEffects.length);
      for (const eff of batch) {
        await eff();
      }
      await new Promise((resolve) => setImmediate(resolve));
      tree = renderNode(React.createElement(ComponentFn, props));
    }
    return tree;
  }

  return {
    React,
    render: (ComponentFn, props = {}) => renderNode(React.createElement(ComponentFn, props)),
    mountAndFlush,
  };
}

function createApiMock(handlers) {
  const requests = [];
  const client = {
    useAPIClient: () => ({
      async request(req) {
        requests.push({
          url: req.url,
          method: (req.method || 'get').toLowerCase(),
          params: req.params || null,
          data: req.data || null,
        });
        const key = `${(req.method || 'get').toLowerCase()} ${req.url}`;
        const fn = handlers[key] || handlers[req.url];
        if (!fn) return { data: { data: {} } };
        const payload = await fn(req);
        return { data: { data: payload } };
      },
    }),
  };
  return { client, requests };
}

test('public-form-builder exports required symbols and obeys Studio security & SPDX header rules', async () => {
  const mod = require(SOURCE_PATH);
  assert.ok(Array.isArray(mod.PUBLIC_FORM_CORE_COLLECTIONS));
  assert.ok(mod.PUBLIC_FORM_CORE_COLLECTIONS.includes('latticeRequests'));
  assert.ok(mod.PUBLIC_FORM_CORE_COLLECTIONS.includes('latticeServiceTickets'));
  assert.ok(Array.isArray(mod.PUBLIC_FORM_FIELD_TYPES));
  assert.ok(mod.PUBLIC_FORM_FIELD_TYPES.includes('email'));
  assert.ok(mod.SLUG_RE instanceof RegExp);
  assert.equal(mod.SLUG_RE.test('partner-intake-01'), true);
  assert.equal(mod.SLUG_RE.test('Bad Slug!'), false);
  assert.equal(typeof mod.createPublicFormBuilderPanel, 'function');
  assert.equal(typeof mod.PublicFormBuilderPanel, 'function');

  const { addSourceHeader } = await import(pathToFileURL(HEADER_SCRIPT).href);
  for (const filePath of [SOURCE_PATH, __filename]) {
    const fileSrc = readFileSync(filePath, 'utf8');
    assert.equal(addSourceHeader(fileSrc, filePath).status, 'present', `SPDX header must be present in ${filePath}`);
  }
  const src = readFileSync(SOURCE_PATH, 'utf8');
  assert.doesNotMatch(src, /require\(['"](?:react|antd|@nocobase\/client)['"]\)/);
  assert.doesNotMatch(src, /\blocalStorage\b|\bsessionStorage\b/);
  assert.doesNotMatch(src, /dangerouslySetInnerHTML/);
});

test('loads forms and custom domains, picks allowlisted fields (excluding protected keys), saves form, and shows dismissible one-time token banner', async () => {
  const { createPublicFormBuilderPanel } = require(SOURCE_PATH);
  const harness = createReactHarness();
  let forms = [
    {
      id: 1,
      organizationId: 'org-a',
      slug: 'existing-intake',
      title: 'Existing Intake',
      targetCollection: 'latticeRequests',
      allowedFieldsJson: [{ name: 'subject', label: 'Subject', type: 'string', required: true }],
      defaultValuesJson: { priority: 'normal' },
      requireAccessToken: false,
      honeypotField: '_hp_website',
      rateLimitPerMinute: 20,
      active: true,
    },
  ];
  const { client, requests } = createApiMock({
    'get dxosForms:list': async () => ({ organizationId: 'org-a', items: forms }),
    'get dxosBuilder:listDomains': async () => ({
      items: [
        {
          collectionName: 'latticeCustomWarrantyClaims',
          title: 'Warranty Claims',
          fields: [
            { name: 'id', type: 'integer', title: 'ID' },
            { name: 'organizationId', type: 'string', title: 'Org' },
            { name: 'status', type: 'string', title: 'Status' },
            { name: 'customerEmail', type: 'email', title: 'Customer Email' },
            { name: 'serialNumber', type: 'string', title: 'Serial Number' },
          ],
        },
      ],
    }),
    'post dxosForms:save': async (req) => {
      const saved = { id: 2, ...req.data };
      forms = [saved, ...forms];
      return { form: saved, accessToken: 'pform_tok_once_secret_123456' };
    },
  });

  const Panel = createPublicFormBuilderPanel(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(Panel, { selectedOrg: 'org-a', organizations: ['org-a'] });

  const table = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-table')[0];
  assert.ok(table);
  assert.ok(textOf(table).includes('existing-intake'));

  // Select custom collection & verify protected keys are excluded from field picker
  const colSelect = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-collection-select')[0];
  assert.ok(colSelect);
  colSelect.props.onChange({ target: { value: 'latticeCustomWarrantyClaims' } });
  tree = harness.render(Panel, { selectedOrg: 'org-a', organizations: ['org-a'] });

  const picker = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-field-picker')[0];
  assert.ok(picker);
  assert.equal(collectNodes(picker, (n) => n.props?.['data-testid'] === 'dxos-forms-pick-field-organizationId').length, 0);
  assert.equal(collectNodes(picker, (n) => n.props?.['data-testid'] === 'dxos-forms-pick-field-status').length, 0);

  const pickEmail = collectNodes(picker, (n) => n.props?.['data-testid'] === 'dxos-forms-pick-field-customerEmail')[0];
  const pickSerial = collectNodes(picker, (n) => n.props?.['data-testid'] === 'dxos-forms-pick-field-serialNumber')[0];
  assert.ok(pickEmail && pickSerial);
  pickEmail.props.onClick();
  pickSerial.props.onClick();

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-slug-input')[0].props.onChange({ target: { value: 'warranty-claim' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-title-input')[0].props.onChange({ target: { value: 'Warranty Claim Form' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-require-token-checkbox')[0].props.onChange({ target: { checked: true } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-defaults-input')[0].props.onChange({ target: { value: '{"source":"web"}' } });

  tree = harness.render(Panel, { selectedOrg: 'org-a', organizations: ['org-a'] });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-save-form')[0].props.onSubmit({ preventDefault() {} });
  tree = harness.render(Panel, { selectedOrg: 'org-a', organizations: ['org-a'] });

  const saveReq = requests.find((r) => r.url === 'dxosForms:save');
  assert.ok(saveReq);
  assert.equal(saveReq.data.slug, 'warranty-claim');
  assert.equal(saveReq.data.targetCollection, 'latticeCustomWarrantyClaims');
  assert.equal(saveReq.data.requireAccessToken, true);
  assert.deepEqual(saveReq.data.defaultValuesJson, { source: 'web' });
  assert.ok(saveReq.data.allowedFieldsJson.some((f) => f.name === 'customerEmail'));

  const banner = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-form-token-once')[0];
  assert.ok(banner, 'One-time access token banner must render');
  assert.ok(textOf(banner).includes('pform_tok_once_secret_123456'));

  const dismissBtn = collectNodes(banner, (n) => n.type === 'button')[0];
  assert.ok(dismissBtn);
  dismissBtn.props.onClick();
  tree = harness.render(Panel, { selectedOrg: 'org-a', organizations: ['org-a'] });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-form-token-once').length, 0);
  assert.equal(JSON.stringify(tree).includes('pform_tok_once_secret_123456'), false);
});

test('blocks invalid slug, malformed defaultValuesJson, and __proto__ keys client-side without calling API', async () => {
  const { createPublicFormBuilderPanel } = require(SOURCE_PATH);
  const harness = createReactHarness();
  const { client, requests } = createApiMock({
    'get dxosForms:list': async () => ({ organizationId: 'org-a', items: [] }),
    'get dxosBuilder:listDomains': async () => ({ items: [] }),
  });

  const Panel = createPublicFormBuilderPanel(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(Panel, { selectedOrg: 'org-a', organizations: ['org-a'] });

  // Invalid slug
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-slug-input')[0].props.onChange({ target: { value: 'INVALID SLUG!' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-title-input')[0].props.onChange({ target: { value: 'Title' } });
  tree = harness.render(Panel, { selectedOrg: 'org-a', organizations: ['org-a'] });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-save-form')[0].props.onSubmit({ preventDefault() {} });
  assert.equal(requests.some((r) => r.url === 'dxosForms:save'), false);

  // Valid slug + malformed JSON
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-slug-input')[0].props.onChange({ target: { value: 'valid-slug' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-defaults-input')[0].props.onChange({ target: { value: '{broken' } });
  tree = harness.render(Panel, { selectedOrg: 'org-a', organizations: ['org-a'] });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-save-form')[0].props.onSubmit({ preventDefault() {} });
  assert.equal(requests.some((r) => r.url === 'dxosForms:save'), false);

  // Valid slug + __proto__ pollution attempt
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-defaults-input')[0].props.onChange({ target: { value: '{"__proto__":{"admin":true}}' } });
  tree = harness.render(Panel, { selectedOrg: 'org-a', organizations: ['org-a'] });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-save-form')[0].props.onSubmit({ preventDefault() {} });
  assert.equal(requests.some((r) => r.url === 'dxosForms:save'), false);
});

test('supports rotateToken, delete, copy /v/form/:slug, standalone org auto-discovery, and zero-PII status preview', async () => {
  const { PublicFormBuilderPanel } = require(SOURCE_PATH);
  const harness = createReactHarness();
  let forms = [
    {
      id: 7,
      organizationId: 'org-auto',
      slug: 'support-intake',
      title: 'Support Intake',
      targetCollection: 'latticeServiceTickets',
      allowedFieldsJson: [{ name: 'title', label: 'Title', type: 'string', required: true }],
      requireAccessToken: true,
      honeypotField: '_hp_website',
      rateLimitPerMinute: 15,
      active: true,
    },
  ];
  const { client, requests } = createApiMock({
    'get dxosStudio:listEmployees': async () => ({ items: [], organizations: ['org-auto'] }),
    'get dxosForms:list': async () => ({ organizationId: 'org-auto', items: forms }),
    'get dxosBuilder:listDomains': async () => { throw new Error('404 unavailable'); },
    'post dxosForms:rotateToken': async () => ({ form: forms[0], accessToken: 'pform_rotated_token_999' }),
    'post dxosForms:delete': async (req) => {
      forms = forms.filter((f) => f.slug !== req.data.slug);
      return { deleted: true };
    },
    'get dxosForms:status': async (req) => ({
      slug: req.params.slug,
      submissionCode: req.params.submissionCode,
      status: 'received',
      submittedAt: '2026-11-25T10:00:00.000Z',
      updatedAt: '2026-11-25T10:05:00.000Z',
    }),
  });

  let copiedText = '';
  const prevNav = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async (t) => { copiedText = t; } } },
  });

  try {
    let tree = await harness.mountAndFlush(PublicFormBuilderPanel, { React: harness.React, client });
    assert.ok(requests.some((r) => r.url === 'dxosStudio:listEmployees'));

    // Copy public link
    const copyBtn = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-copy-link-support-intake')[0];
    assert.ok(copyBtn);
    await copyBtn.props.onClick();
    assert.equal(copiedText, '/v/form/support-intake');

    // Rotate token
    const rotateBtn = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-rotate-token-support-intake')[0];
    assert.ok(rotateBtn);
    await rotateBtn.props.onClick();
    tree = harness.render(PublicFormBuilderPanel, { React: harness.React, client });
    assert.ok(requests.some((r) => r.url === 'dxosForms:rotateToken' && r.data.slug === 'support-intake'));
    const tokenBanner = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-form-token-once')[0];
    assert.ok(tokenBanner && textOf(tokenBanner).includes('pform_rotated_token_999'));

    // Status preview
    collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-status-slug-input')[0].props.onChange({ target: { value: 'support-intake' } });
    collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-status-code-input')[0].props.onChange({ target: { value: 'SUB-2026-01' } });
    tree = harness.render(PublicFormBuilderPanel, { React: harness.React, client });
    await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-status-preview-form')[0].props.onSubmit({ preventDefault() {} });
    tree = harness.render(PublicFormBuilderPanel, { React: harness.React, client });
    const statusResult = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-status-preview-result')[0];
    assert.ok(statusResult);
    assert.ok(textOf(statusResult).includes('SUB-2026-01'));
    assert.ok(textOf(statusResult).includes('received'));

    // Delete form
    const deleteBtn = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-delete-support-intake')[0];
    assert.ok(deleteBtn);
    await deleteBtn.props.onClick();
    assert.ok(requests.some((r) => r.url === 'dxosForms:delete' && r.data.slug === 'support-intake'));
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: prevNav });
  }
});

test('handles top-level { id } save response, updated status token placeholder, and [null] array elements without crashing', async () => {
  const { createPublicFormBuilderPanel } = require(SOURCE_PATH);
  const harness = createReactHarness();
  const validForm = {
    id: 19,
    organizationId: 'org-a',
    slug: 'null-safe-form',
    title: 'Null Safe Form',
    targetCollection: 'latticeRequests',
    allowedFieldsJson: [null, { name: 'subject', label: 'Subject', type: 'string', required: true }],
    defaultValuesJson: {},
    active: true,
  };
  let saveCalls = 0;
  const { client, requests } = createApiMock({
    'get dxosForms:list': async () => ({ organizationId: 'org-a', items: [null, validForm] }),
    'get dxosBuilder:listDomains': async () => ({ items: [null] }),
    'post dxosForms:save': async (req) => {
      saveCalls += 1;
      return { id: 42, slug: req.data.slug, title: req.data.title };
    },
  });

  const Panel = createPublicFormBuilderPanel(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(Panel, { selectedOrg: 'org-a', organizations: ['org-a'] });

  // Updated status token placeholder
  const tokenInput = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-status-token-input')[0];
  assert.ok(tokenInput);
  assert.equal(tokenInput.props.placeholder, 'Status Token (bắt buộc khi tra cứu)');

  // Table renders validForm while ignoring null entry
  const table = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-table')[0];
  assert.ok(textOf(table).includes('null-safe-form'));

  // Clicking Edit on form with allowedFieldsJson containing null does not crash
  const editBtn = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-edit-null-safe-form')[0];
  assert.ok(editBtn);
  editBtn.props.onClick();
  tree = harness.render(Panel, { selectedOrg: 'org-a', organizations: ['org-a'] });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-slug-input')[0].props.value, 'null-safe-form');

  // Reset to new form, save returning top-level { id: 42 }, then save again -> second Save must carry id: 42
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-reset-btn')[0].props.onClick();
  tree = harness.render(Panel, { selectedOrg: 'org-a', organizations: ['org-a'] });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-slug-input')[0].props.onChange({ target: { value: 'top-level-id-form' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-title-input')[0].props.onChange({ target: { value: 'Top Level ID' } });
  tree = harness.render(Panel, { selectedOrg: 'org-a', organizations: ['org-a'] });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-save-form')[0].props.onSubmit({ preventDefault() {} });
  tree = harness.render(Panel, { selectedOrg: 'org-a', organizations: ['org-a'] });

  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-forms-save-form')[0].props.onSubmit({ preventDefault() {} });
  const saveReqs = requests.filter((r) => r.url === 'dxosForms:save');
  assert.equal(saveCalls, 2);
  assert.equal(saveReqs[0].data.id, undefined);
  assert.equal(saveReqs[1].data.id, 42);
});
