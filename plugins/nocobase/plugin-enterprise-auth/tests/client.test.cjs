/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createHarness() {
  let stateIdx = 0;
  const states = [];
  const effects = [];
  const resetCalls = [];

  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: children.length ? { ...(props || {}), children: children.length === 1 ? children[0] : children } : (props || {}),
      children,
    }),
    useState(init) {
      const i = stateIdx++;
      if (!(i in states)) states[i] = typeof init === 'function' ? init() : init;
      return [states[i], (val) => { states[i] = typeof val === 'function' ? val(states[i]) : val; }];
    },
    useCallback(fn) { return fn; },
    useRef(init) {
      const i = stateIdx++;
      if (!(i in states)) states[i] = { current: init };
      return states[i];
    },
    useEffect(fn) { effects.push(fn); },
  };

  const formObj = {
    resetFields() { resetCalls.push(true); },
  };

  const antd = {
    Alert: 'Alert',
    Button: 'Button',
    Descriptions: 'Descriptions',
    Form: Object.assign('Form', {
      Item: 'Form.Item',
      useForm: () => [formObj],
    }),
    Input: 'Input',
    Popconfirm: 'Popconfirm',
    Result: 'Result',
    Select: 'Select',
    Space: 'Space',
    Spin: 'Spin',
    Table: 'Table',
    Typography: { Title: 'Title', Text: 'Text' },
  };

  let capturedPluginSettings = null;
  let capturedApi = null;
  const client = {
    Plugin: class {},
    useAPIClient: () => capturedApi,
    SchemaSettings: class { constructor(cfg) { Object.assign(this, cfg); } },
    SchemaSettingsBlockTitleItem: 'TitleItem',
    useSchemaInitializerItem: () => ({}),
    useSchemaInitializer: () => ({ insert() {} }),
  };

  let factory;
  const define = (_name, _deps, fn) => { factory = fn; };
  define.amd = {};
  const srcPath = path.resolve(__dirname, '../src/client/index.js');
  vm.runInNewContext(readFileSync(srcPath, 'utf8'), {
    define,
    window: { location: { search: '', replace() {}, assign() {} }, history: { replaceState() {} } },
    URLSearchParams,
    Error,
  });

  const mod = factory(client, React, antd, { default: class {} });
  const plugin = new mod.default();
  plugin.app = {
    pm: { get: () => ({ registerType() {} }) },
    schemaSettingsManager: { add() {} },
    addComponents() {},
    router: { add() {} },
    pluginSettingsManager: {
      add(name, cfg) { if (name === 'auth.enterprise-mappings') capturedPluginSettings = cfg; },
    },
    schemaInitializerManager: { get: () => null },
  };

  return {
    async init(api) {
      capturedApi = api;
      await plugin.load();
      return capturedPluginSettings.Component;
    },
    render(Component) {
      stateIdx = 0;
      effects.length = 0;
      return Component();
    },
    async flushEffects() {
      const pending = effects.splice(0, effects.length);
      for (const fn of pending) fn();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
    resetCalls,
    antd,
  };
}

function findNode(node, pred) {
  if (!node || typeof node !== 'object') return null;
  if (pred(node)) return node;
  const kids = [];
  if (Array.isArray(node.children)) kids.push(...node.children);
  if (node.props?.children) {
    if (Array.isArray(node.props.children)) kids.push(...node.props.children);
    else kids.push(node.props.children);
  }
  for (const k of kids) {
    const found = findNode(k, pred);
    if (found) return found;
  }
  return null;
}

function findAllNodes(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (pred(node)) out.push(node);
  const kids = [];
  if (Array.isArray(node.children)) kids.push(...node.children);
  if (node.props?.children) {
    if (Array.isArray(node.props.children)) kids.push(...node.props.children);
    else kids.push(node.props.children);
  }
  for (const k of kids) findAllNodes(k, pred, out);
  return out;
}

test('MappingSettings surfaces loadMappings errors, passes Table loading state, wraps unlink in Popconfirm, resets form on link, and validates numeric userId', async () => {
  // 1. loadMappings error is surfaced cleanly in an error Alert instead of silently swallowed
  {
    const h = createHarness();
    const api = {
      async request(req) {
        if (req.url === 'enterpriseAuth:configuration') return { data: { data: { issuer: 'http://kc' } } };
        if (req.url === 'enterpriseAuth:listMappings') throw new Error('Network error');
        return { data: {} };
      },
    };
    const MappingSettings = await h.init(api);
    let tree = h.render(MappingSettings);
    await h.flushEffects();
    tree = h.render(MappingSettings);
    const alerts = findAllNodes(tree, (n) => n.type === h.antd.Alert && n.props?.type === 'error');
    assert.ok(alerts.some((a) => String(a.props.message || '').includes('Không thể tải')), 'Expected Vietnamese error alert when listMappings fails');
  }

  // 2. Popconfirm wraps Gỡ liên kết + form.resetFields() on link + numeric userId rule + Table loading prop
  {
    const h = createHarness();
    const calls = [];
    const sampleRow = { authenticator: 'native-keycloak', subject: 'sub-1', userId: 12, issuer: 'http://kc' };
    const api = {
      async request(req) {
        calls.push(req);
        if (req.url === 'enterpriseAuth:configuration') return { data: { data: { issuer: 'http://kc' } } };
        if (req.url === 'enterpriseAuth:listMappings') return { data: { data: { items: [sampleRow] } } };
        if (req.url === 'enterpriseAuth:link') return { data: { data: { ok: true } } };
        if (req.url === 'enterpriseAuth:unlink') return { data: { data: { ok: true } } };
        return { data: {} };
      },
    };
    const MappingSettings = await h.init(api);
    let tree = h.render(MappingSettings);
    await h.flushEffects();
    tree = h.render(MappingSettings);

    const table = findNode(tree, (n) => n.type === h.antd.Table);
    assert.ok(table);
    assert.equal(typeof table.props.loading, 'boolean', 'Table must receive boolean loading prop');

    const actionCol = table.props.columns.find((c) => c.key === 'action');
    assert.ok(actionCol);
    const actionCell = actionCol.render(null, sampleRow);
    assert.equal(actionCell.type, h.antd.Popconfirm, 'Gỡ liên kết button must be wrapped in antd.Popconfirm');
    assert.ok(String(actionCell.props.title || '').length > 0);
    assert.equal(actionCell.props.okButtonProps?.danger, true);

    // Clicking inner Button does NOT fire unlink directly
    const innerBtn = findNode(actionCell, (n) => n.type === h.antd.Button);
    assert.ok(innerBtn);
    assert.equal(innerBtn.props.onClick, undefined, 'Button inside Popconfirm must not trigger immediate unlink');
    assert.equal(calls.filter((c) => c.url === 'enterpriseAuth:unlink').length, 0);

    // Confirming Popconfirm executes unlink
    await actionCell.props.onConfirm();
    assert.equal(calls.filter((c) => c.url === 'enterpriseAuth:unlink').length, 1);

    // Form validation rules include Vietnamese message & numeric userId pattern
    const formNode = findNode(tree, (n) => n.type === h.antd.Form);
    assert.ok(formNode);
    const userIdItem = findNode(formNode, (n) => n.type === h.antd.Form.Item && n.props?.name === 'userId');
    assert.ok(userIdItem);
    assert.ok(userIdItem.props.rules.some((r) => r.pattern && r.pattern.test('123') && !r.pattern.test('abc')), 'userId rule must enforce digits');

    // Submitting link resets form fields
    await formNode.props.onFinish({ authenticator: 'native-keycloak', subject: 'sub-2', userId: '15' });
    assert.equal(calls.filter((c) => c.url === 'enterpriseAuth:link').length, 1);
    assert.equal(h.resetCalls.length, 1, 'Successful link must call form.resetFields()');
  }
});
