const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const mediaDir = path.join(root, 'media');

class TestEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = Boolean(init.bubbles);
    this.key = init.key || '';
    this.ctrlKey = Boolean(init.ctrlKey);
    this.metaKey = Boolean(init.metaKey);
    this.target = init.target || null;
    this.defaultPrevented = false;
    this.propagationStopped = false;
  }

  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
}

class ClassList {
  constructor() { this.items = new Set(); }
  add(...names) { names.forEach((name) => this.items.add(name)); }
  remove(...names) { names.forEach((name) => this.items.delete(name)); }
  contains(name) { return this.items.has(name); }
  toggle(name, force) {
    if (force === true) { this.items.add(name); return true; }
    if (force === false) { this.items.delete(name); return false; }
    if (this.items.has(name)) { this.items.delete(name); return false; }
    this.items.add(name);
    return true;
  }
}

class TestElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.attributes = new Map();
    this.dataset = {};
    this.classList = new ClassList();
    this.style = {};
    this.value = '';
    this.textContent = '';
    this._innerHTML = '';
    this.hidden = false;
    this.disabled = false;
    this.files = null;
  }

  set id(value) {
    this._id = value;
    if (value) { this.ownerDocument.elements.set(value, this); }
  }

  get id() { return this._id || ''; }

  get firstChild() { return this.children[0] || null; }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.children = [];
    this.textContent = '';
  }

  get innerHTML() { return this._innerHTML; }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) { this.children.splice(index, 1); }
    child.parentElement = null;
    return child;
  }

  remove() {
    if (this.parentElement) { this.parentElement.removeChild(this); }
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  dispatchEvent(event) {
    event.target = event.target || this;
    for (const handler of this.listeners.get(event.type) || []) {
      handler.call(this, event);
    }
    return !event.defaultPrevented;
  }

  click() {
    this.dispatchEvent(new TestEvent('click', { target: this }));
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  setSelectionRange() {}

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'id') { this.id = String(value); }
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = String(value);
    }
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  closest(selector) {
    if (selector.startsWith('.') && this.classList.contains(selector.slice(1))) { return this; }
    if (selector.startsWith('#') && this.id === selector.slice(1)) { return this; }
    return this.parentElement ? this.parentElement.closest(selector) : null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const out = [];
    const matches = (node) => {
      if (selector.startsWith('.')) { return node.classList.contains(selector.slice(1)); }
      if (selector.startsWith('#')) { return node.id === selector.slice(1); }
      if (selector === '[data-secret-matched]') { return node.attributes.has('data-secret-matched'); }
      return false;
    };
    const visit = (node) => {
      if (matches(node)) { out.push(node); }
      node.children.forEach(visit);
    };
    this.children.forEach(visit);
    return out;
  }
}

class TestDocument {
  constructor() {
    this.elements = new Map();
    this.listeners = new Map();
    this.activeElement = null;
    this.body = this.createElement('body');
  }

  createElement(tagName) {
    return new TestElement(tagName, this);
  }

  getElementById(id) {
    return this.elements.get(id) || null;
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  dispatchEvent(event) {
    event.target = event.target || this;
    for (const handler of this.listeners.get(event.type) || []) {
      handler.call(this, event);
    }
  }
}

function createFixture() {
  const document = new TestDocument();
  const ids = [
    'promptInput', 'loading', 'resultCard', 'responseCard', 'responseContent', 'streamBadge',
    'modeSelect', 'btnPrimary', 'optimizedCard', 'optimizedPrompt', 'densitySelect',
    'btnSettingsMenu', 'settingsMenu', 'btnRefreshOverview', 'btnOpenChat', 'btnUseOptimized',
    'btnCopyOptimized', 'btnSecretSettings', 'btnResetDefaults', 'btnReadme', 'chipTour',
    'chipGuide', 'chipHistory', 'chipExample', 'chipMemory', 'chipPeers', 'chipAgents',
    'chipVersions', 'chipReport', 'btnClearInput', 'btnClearOptimized', 'btnCommitOptimized',
    'btnMic', 'alerts', 'attachmentStrip', 'imageFileInput', 'statusStrip', 'memoryCount',
    'kgCount', 'cacheCount', 'peerCount', 'digestCount', 'pillMemory', 'pillKg', 'pillCache',
    'pillPeers', 'pillDigests', 'inputTokenCount', 'optimizedTokenCount',
    'agentMgrOverlay', 'agentName', 'agentContent', 'agentDropZone', 'agentFileInput',
    'agentError', 'agentSavedNotice', 'agentSavedText', 'btnRemoveAgent', 'btnAgentClose',
    'btnCancelAgent', 'btnManageBundledAgents', 'btnAgentBrowse', 'btnSaveAgent',
  ];

  for (const id of ids) {
    const tagName = id === 'promptInput' || id === 'agentContent' ? 'textarea'
      : id === 'modeSelect' || id === 'densitySelect' ? 'select'
      : id.endsWith('Overlay') || id.endsWith('Card') || id === 'settingsMenu' || id === 'alerts' ? 'div'
      : 'button';
    const element = document.createElement(tagName);
    element.id = id;
    document.body.appendChild(element);
  }

  document.getElementById('modeSelect').value = 'optimize';
  document.getElementById('densitySelect').value = 'rich';
  document.getElementById('settingsMenu').hidden = true;
  document.getElementById('agentMgrOverlay').style.display = 'none';
  document.getElementById('optimizedCard').style.display = 'none';
  document.getElementById('loading').style.display = 'none';
  document.getElementById('responseCard').style.display = 'none';

  return document;
}

function runScript(context, fileName) {
  const code = fs.readFileSync(path.join(mediaDir, fileName), 'utf8');
  vm.runInContext(code, context, { filename: fileName });
}

function loadPanel() {
  const messages = [];
  const windowListeners = new Map();
  const document = createFixture();
  const context = vm.createContext({
    console,
    document,
    window: null,
    navigator: { language: 'en-US' },
    Event: TestEvent,
    FileReader: class {},
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    SECRET_PATTERN_MODE_LABELS: { regex: 'Regex' },
    SECRET_PATTERN_MODE_PLACEHOLDERS: { regex: 'Pattern' },
    acquireVsCodeApi: () => ({ postMessage: (message) => messages.push(message) }),
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
  });
  context.window = context;
  context.addEventListener = (type, handler) => {
    const handlers = windowListeners.get(type) || [];
    handlers.push(handler);
    windowListeners.set(type, handlers);
  };
  context.dispatchEvent = (event) => {
    for (const handler of windowListeners.get(event.type) || []) {
      handler.call(context, event);
    }
  };

  runScript(context, 'panel.agents.js');
  runScript(context, 'panel.helpers.js');
  runScript(context, 'panel.render.js');
  runScript(context, 'panel.js');

  assert.equal(messages.pop().type, 'ready');
  messages.length = 0;
  return { context, document, messages };
}

function el(document, id) {
  const node = document.getElementById(id);
  assert.ok(node, `missing #${id}`);
  return node;
}

function click(document, id) {
  el(document, id).click();
}

function assertLastMessage(messages, expected) {
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), expected);
}

function assertPosts(document, messages, id, expected) {
  click(document, id);
  assertLastMessage(messages, expected);
}

function assertHostAccepts(messageTypes) {
  const validator = fs.readFileSync(path.join(root, 'src', 'webview', 'validator.ts'), 'utf8');
  const provider = fs.readFileSync(path.join(root, 'src', 'panel', 'PromptProxyViewProvider.ts'), 'utf8');
  for (const type of messageTypes) {
    assert.match(validator, new RegExp(`'${type}'`), `${type} must be allowed by validateMessage`);
    assert.match(provider, new RegExp(`case '${type}'`), `${type} must be handled by PromptProxyViewProvider`);
  }
}

function run() {
  const { context, document, messages } = loadPanel();

  assertHostAccepts([
    'openOnboarding', 'openUserGuide', 'showHistory', 'showPromptLog', 'openMemoryFile',
    'openPeerWorkspaces', 'manageAgentSkills', 'reportIssue', 'openChat', 'refreshOverview',
    'openReadme', 'openSecretSettings', 'resetToDefaults', 'setDensity', 'setMode',
    'analyze', 'agentRun', 'openChatWithPrompt', 'sendPrompt', 'copyPrompt', 'commitPrompt',
    'createAgent',
  ]);

  assertPosts(document, messages, 'chipTour', { type: 'openOnboarding' });
  assertPosts(document, messages, 'chipGuide', { type: 'openUserGuide' });
  assertPosts(document, messages, 'chipHistory', { type: 'showHistory' });
  assertPosts(document, messages, 'chipVersions', { type: 'showPromptLog' });
  assertPosts(document, messages, 'chipMemory', { type: 'openMemoryFile' });
  assertPosts(document, messages, 'chipPeers', { type: 'openPeerWorkspaces' });
  assertPosts(document, messages, 'chipReport', { type: 'reportIssue' });
  assertPosts(document, messages, 'btnOpenChat', { type: 'openChat' });

  click(document, 'btnRefreshOverview');
  assertLastMessage(messages, { type: 'refreshOverview' });
  assert.equal(el(document, 'btnRefreshOverview').disabled, true);
  assert.equal(el(document, 'btnRefreshOverview').getAttribute('aria-busy'), 'true');

  context.window.dispatchEvent({ type: 'message', data: { type: 'overviewRefreshed' } });
  assert.equal(el(document, 'btnRefreshOverview').disabled, false);
  assert.equal(el(document, 'btnRefreshOverview').getAttribute('aria-busy'), null);

  el(document, 'densitySelect').value = 'lean';
  el(document, 'densitySelect').dispatchEvent(new TestEvent('change'));
  assertLastMessage(messages, { type: 'setDensity', density: 'lean' });

  el(document, 'promptInput').value = '';
  click(document, 'btnPrimary');
  assert.match(el(document, 'alerts').children.at(-1).textContent, /Enter a prompt/);

  el(document, 'promptInput').value = 'optimize this';
  click(document, 'btnPrimary');
  assertLastMessage(messages, { type: 'analyze', prompt: 'optimize this' });

  el(document, 'modeSelect').value = 'agent';
  el(document, 'modeSelect').dispatchEvent(new TestEvent('change'));
  assertLastMessage(messages, { type: 'setMode', mode: 'agent' });
  click(document, 'btnPrimary');
  assertLastMessage(messages, { type: 'agentRun', prompt: 'optimize this' });

  el(document, 'modeSelect').value = 'direct';
  el(document, 'modeSelect').dispatchEvent(new TestEvent('change'));
  assertLastMessage(messages, { type: 'setMode', mode: 'direct' });
  click(document, 'btnPrimary');
  assertLastMessage(messages, { type: 'openChatWithPrompt', prompt: 'optimize this' });

  context.currentState = null;
  click(document, 'btnUseOptimized');
  assert.match(el(document, 'alerts').children.at(-1).textContent, /Run Optimize or Agent first/);

  context.currentState = { optimized: 'optimized prompt' };
  assertPosts(document, messages, 'btnUseOptimized', { type: 'sendPrompt', prompt: 'optimized prompt' });
  assertPosts(document, messages, 'btnCopyOptimized', { type: 'copyPrompt', prompt: 'optimized prompt' });

  el(document, 'promptInput').value = 'raw prompt';
  el(document, 'optimizedPrompt').textContent = 'optimized version';
  assertPosts(document, messages, 'btnCommitOptimized', {
    type: 'commitPrompt',
    prompt: 'raw prompt',
    optimized: 'optimized version',
  });
  click(document, 'btnClearOptimized');
  assert.equal(el(document, 'optimizedPrompt').textContent, '');
  assert.equal(el(document, 'optimizedCard').style.display, 'none');

  el(document, 'promptInput').value = 'delete me';
  click(document, 'btnClearInput');
  assert.equal(el(document, 'promptInput').value, '');
  assert.equal(document.activeElement, el(document, 'promptInput'));

  click(document, 'chipExample');
  assert.match(el(document, 'promptInput').value, /Refactor the auth middleware/);
  assert.equal(document.activeElement, el(document, 'promptInput'));

  click(document, 'btnSettingsMenu');
  assert.equal(el(document, 'settingsMenu').hidden, false);
  assert.equal(el(document, 'btnSettingsMenu').getAttribute('aria-expanded'), 'true');
  assertPosts(document, messages, 'btnReadme', { type: 'openReadme' });
  assert.equal(el(document, 'settingsMenu').hidden, true);

  click(document, 'btnSettingsMenu');
  assertPosts(document, messages, 'btnSecretSettings', { type: 'openSecretSettings' });
  click(document, 'btnSettingsMenu');
  assertPosts(document, messages, 'btnResetDefaults', { type: 'resetToDefaults' });

  click(document, 'chipAgents');
  assert.equal(el(document, 'agentMgrOverlay').style.display, 'block');
  click(document, 'btnAgentClose');
  assert.equal(el(document, 'agentMgrOverlay').style.display, 'none');

  click(document, 'chipAgents');
  assertPosts(document, messages, 'btnManageBundledAgents', { type: 'manageAgentSkills' });
  assert.equal(el(document, 'agentMgrOverlay').style.display, 'none');

  click(document, 'chipAgents');
  click(document, 'btnSaveAgent');
  assert.match(el(document, 'agentError').textContent, /Enter an agent name/);
  el(document, 'agentName').value = 'Release Writer';
  el(document, 'agentContent').value = 'Write concise release notes.';
  assertPosts(document, messages, 'btnSaveAgent', {
    type: 'createAgent',
    agentName: 'Release Writer',
    agentContent: 'Write concise release notes.',
  });

  console.log('Panel button webview tests passed.');
}

run();