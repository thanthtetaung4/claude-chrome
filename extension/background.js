// Claude Browser Bridge - service worker.
// Connects to the local MCP server over WebSocket and executes browser commands
// through the Chrome DevTools Protocol (chrome.debugger).

const PORT = 18765;
const RETRY_MS = 3000;

// ---------------------------------------------------------------- connection
let ws = null;
let connected = false;
let retryTimer = null;

function setBadge(on) {
  chrome.action.setBadgeText({ text: on ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: on ? '#1a7f37' : '#888888' });
}

function scheduleReconnect() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; connect(); }, RETRY_MS);
}

function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  } catch {
    return scheduleReconnect();
  }
  ws.onopen = () => { connected = true; setBadge(true); };
  ws.onclose = () => { connected = false; setBadge(false); scheduleReconnect(); };
  ws.onerror = () => {};
  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === 'ping' || msg.id === undefined) return;
    const socket = ws;
    try {
      const handler = HANDLERS[msg.method];
      if (!handler) throw new Error(`Unknown command: ${msg.method}`);
      const result = await handler(msg.params || {});
      socket.send(JSON.stringify({ id: msg.id, result }));
    } catch (err) {
      socket.send(JSON.stringify({ id: msg.id, error: String(err?.message || err) }));
    }
  };
}

chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'status') sendResponse({ connected, port: PORT });
  if (msg.type === 'reconnect') { try { ws?.close(); } catch {} connect(); sendResponse({}); }
});
setBadge(false);
connect();

// ---------------------------------------------------------------- CDP helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (s) => [{ type: 'text', text: s }];
const attached = new Set();
const dprByTab = new Map();
const eventWaiters = new Set();

chrome.debugger.onDetach.addListener((source) => attached.delete(source.tabId));
chrome.tabs.onRemoved.addListener((tabId) => { attached.delete(tabId); dprByTab.delete(tabId); });
chrome.debugger.onEvent.addListener((source, method, params) => {
  for (const w of eventWaiters) {
    if (w.tabId === source.tabId && w.method === method) {
      eventWaiters.delete(w);
      w.resolve(params);
    }
  }
});

function waitForEvent(tabId, method, timeoutMs) {
  return new Promise((resolve, reject) => {
    const w = { tabId, method, resolve };
    eventWaiters.add(w);
    setTimeout(() => {
      if (eventWaiters.delete(w)) reject(new Error(`Timed out waiting for ${method}`));
    }, timeoutMs);
  });
}

async function attach(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (err) {
    const m = String(err?.message || err);
    if (!/already attached/i.test(m)) {
      throw new Error(`Cannot control this tab (${m}). Browser-internal pages like chrome:// and the Web Store can't be automated.`);
    }
  }
  attached.add(tabId);
}

async function cdp(tabId, method, params = {}) {
  await attach(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

// Runs `fn` inside the page with JSON-serialisable args and returns its value.
async function evalInPage(tabId, fn, ...args) {
  const res = await cdp(tabId, 'Runtime.evaluate', {
    expression: `(${fn.toString()})(...${JSON.stringify(args)})`,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  }
  return res.result.value;
}

async function resolveTabId(params) {
  if (params.tabId != null) return params.tabId;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('No active tab found. Use list_tabs and pass a tabId.');
  return tab.id;
}

async function waitForLoad(tabId, timeoutMs = 20000) {
  await sleep(300);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return tab;
    await sleep(250);
  }
  return chrome.tabs.get(tabId);
}

const describeTab = (t) => `Tab ${t.id}: ${t.title || '(no title)'}\n${t.url || t.pendingUrl || ''}`;

// Scrolls a ref'd element into view and returns its centre in CSS pixels.
async function elementCenter(tabId, ref) {
  const r = await evalInPage(tabId, (ref) => {
    const el = document.querySelector(`[data-mcp-ref="${ref}"]`);
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const b = el.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height };
  }, ref);
  if (!r) throw new Error(`Element ${ref} not found. The page may have changed; call read_page again.`);
  if (r.w === 0 && r.h === 0) throw new Error(`Element ${ref} is not visible, so it can't be clicked.`);
  return r;
}

const BUTTON_MASK = { left: 1, right: 2, middle: 4 };

async function mouseClick(tabId, x, y, button = 'left', count = 1) {
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (let i = 1; i <= count; i++) {
    const base = { x, y, button, clickCount: i };
    await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: BUTTON_MASK[button] });
    await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
  }
}

const KEYS = {
  enter: ['Enter', 'Enter', 13, '\r'], tab: ['Tab', 'Tab', 9], escape: ['Escape', 'Escape', 27], esc: ['Escape', 'Escape', 27],
  backspace: ['Backspace', 'Backspace', 8], delete: ['Delete', 'Delete', 46], space: [' ', 'Space', 32, ' '],
  arrowup: ['ArrowUp', 'ArrowUp', 38], arrowdown: ['ArrowDown', 'ArrowDown', 40],
  arrowleft: ['ArrowLeft', 'ArrowLeft', 37], arrowright: ['ArrowRight', 'ArrowRight', 39],
  up: ['ArrowUp', 'ArrowUp', 38], down: ['ArrowDown', 'ArrowDown', 40], left: ['ArrowLeft', 'ArrowLeft', 37], right: ['ArrowRight', 'ArrowRight', 39],
  home: ['Home', 'Home', 36], end: ['End', 'End', 35], pageup: ['PageUp', 'PageUp', 33], pagedown: ['PageDown', 'PageDown', 34],
};
for (let i = 1; i <= 12; i++) KEYS[`f${i}`] = [`F${i}`, `F${i}`, 111 + i];
const MODIFIERS = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

async function pressKey(tabId, combo) {
  const parts = combo.length > 1 ? combo.split('+') : [combo];
  const keyName = parts.pop();
  let modifiers = 0;
  for (const m of parts) {
    const bit = MODIFIERS[m.trim().toLowerCase()];
    if (!bit) throw new Error(`Unknown modifier "${m}" in "${combo}".`);
    modifiers |= bit;
  }
  let key, code, keyCode, keyText;
  const known = KEYS[keyName.toLowerCase()];
  if (known) {
    [key, code, keyCode, keyText] = known;
  } else if (keyName.length === 1) {
    const up = keyName.toUpperCase();
    key = keyName;
    code = /[A-Z]/.test(up) ? `Key${up}` : /[0-9]/.test(up) ? `Digit${up}` : '';
    keyCode = code ? up.charCodeAt(0) : 0;
    keyText = keyName;
  } else {
    throw new Error(`Unknown key "${keyName}".`);
  }
  const textOut = modifiers & (1 | 2 | 4) ? undefined : keyText;
  const common = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...common, type: textOut ? 'keyDown' : 'rawKeyDown', text: textOut, unmodifiedText: textOut });
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...common, type: 'keyUp' });
}

// ---------------------------------------------------------------- page-side functions (run via evalInPage)
function pageReadElements(filter, viewportOnly) {
  const SEL = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=radio],' +
    '[role=tab],[role=menuitem],[role=option],[role=combobox],[role=textbox],[role=switch],[role=searchbox],' +
    '[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  const LIMIT = 500;
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const root = document.documentElement;
  let counter = Number(root.dataset.mcpRefCounter || 0);
  const lines = [];
  let total = 0;
  for (const el of document.querySelectorAll(SEL)) {
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? (el.type || 'text') : '';
    if (type === 'hidden') continue;
    const isFile = type === 'file';
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    const visible = r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    if (!visible && !isFile) continue; // hidden file inputs still matter for uploads
    const inView = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    if (viewportOnly && !inView && !isFile) continue;

    const name = clean(
      el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') ||
      (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('placeholder') ||
      (tag === 'input' ? '' : el.innerText) || el.getAttribute('name') || el.id);
    const role = el.getAttribute('role') || (type ? `input[${type}]` : tag);
    let desc = `${role} "${name}"`;
    if ((tag === 'input' || tag === 'textarea') && !['password', 'file', 'checkbox', 'radio'].includes(type) && el.value) {
      desc += ` value="${clean(el.value)}"`;
    }
    if (tag === 'select') desc += ` selected="${clean(el.selectedOptions[0]?.text)}"`;
    if (type === 'checkbox' || type === 'radio' || el.getAttribute('aria-checked')) {
      desc += (el.checked || el.getAttribute('aria-checked') === 'true') ? ' [checked]' : ' [unchecked]';
    }
    if (isFile) desc += `${el.multiple ? ' [multiple]' : ''}${el.accept ? ` accept="${el.accept}"` : ''}${visible ? '' : ' [hidden]'}`;
    if (tag === 'a') desc += ` -> ${el.getAttribute('href').slice(0, 80)}`;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') desc += ' [disabled]';
    if (!inView && visible) desc += ' [offscreen]';
    if (filter && !desc.toLowerCase().includes(filter.toLowerCase())) continue;

    total++;
    if (lines.length >= LIMIT) continue;
    if (!el.dataset.mcpRef) el.dataset.mcpRef = `e${++counter}`;
    lines.push(`[${el.dataset.mcpRef}] ${desc}`);
  }
  root.dataset.mcpRefCounter = String(counter);
  const more = total > lines.length ? `\n... ${total - lines.length} more (use filter or viewportOnly)` : '';
  return `URL: ${location.href}\nTitle: ${document.title}\nScroll: ${Math.round(scrollY)}/${Math.max(0, document.documentElement.scrollHeight - innerHeight)}\n\n` +
    (lines.join('\n') || '(no interactive elements found)') + more;
}

// ---------------------------------------------------------------- command handlers
const HANDLERS = {
  async list_tabs() {
    const tabs = await chrome.tabs.query({});
    return text(tabs.map((t) => `${t.active ? '*' : ' '} ${t.id} | ${(t.title || '').slice(0, 80)} | ${t.url}`).join('\n') +
      '\n(* = active tab in its window)');
  },

  async new_tab({ url }) {
    const tab = await chrome.tabs.create({ url: url ? normalizeUrl(url) : undefined, active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return text(describeTab(await waitForLoad(tab.id)));
  },

  async switch_tab({ tabId }) {
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return text(describeTab(tab));
  },

  async close_tab({ tabId }) {
    await chrome.tabs.remove(tabId);
    return text(`Closed tab ${tabId}.`);
  },

  async navigate(params) {
    const tabId = await resolveTabId(params);
    const url = String(params.url).trim();
    if (url === 'back') await chrome.tabs.goBack(tabId);
    else if (url === 'forward') await chrome.tabs.goForward(tabId);
    else if (url === 'reload') await chrome.tabs.reload(tabId);
    else await chrome.tabs.update(tabId, { url: normalizeUrl(url) });
    return text(describeTab(await waitForLoad(tabId)));
  },

  async screenshot(params) {
    const tabId = await resolveTabId(params);
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) { await chrome.tabs.update(tabId, { active: true }); await sleep(300); }
    dprByTab.set(tabId, await evalInPage(tabId, () => window.devicePixelRatio || 1));
    const { data } = await cdp(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 70 });
    return [
      { type: 'image', data, mimeType: 'image/jpeg' },
      { type: 'text', text: `${describeTab(tab)}\nPixel coordinates in this image can be passed to click(x, y).` },
    ];
  },

  async read_page(params) {
    const tabId = await resolveTabId(params);
    return text(await evalInPage(tabId, pageReadElements, params.filter || '', !!params.viewportOnly));
  },

  async get_text(params) {
    const tabId = await resolveTabId(params);
    const max = params.maxChars || 30000;
    const t = await evalInPage(tabId, (ref) => {
      const el = ref ? document.querySelector(`[data-mcp-ref="${ref}"]`) : document.body;
      if (!el) return null;
      return `URL: ${location.href}\nTitle: ${document.title}\n\n${el.innerText}`;
    }, params.ref || null);
    if (t === null) throw new Error(`Element ${params.ref} not found; call read_page again.`);
    return text(t.length > max ? `${t.slice(0, max)}\n... [truncated, ${t.length - max} more chars]` : t);
  },

  async click(params) {
    const tabId = await resolveTabId(params);
    let x, y;
    if (params.ref) {
      ({ x, y } = await elementCenter(tabId, params.ref));
    } else if (params.x != null && params.y != null) {
      // Screenshot pixels are device pixels; CDP input uses CSS pixels.
      let dpr = dprByTab.get(tabId);
      if (!dpr) { dpr = await evalInPage(tabId, () => window.devicePixelRatio || 1); dprByTab.set(tabId, dpr); }
      x = params.x / dpr; y = params.y / dpr;
    } else {
      throw new Error('Provide either ref or x and y.');
    }
    await mouseClick(tabId, x, y, params.button || 'left', params.double ? 2 : 1);
    await sleep(400);
    const tab = await chrome.tabs.get(tabId);
    return text(`Clicked ${params.ref || `(${params.x}, ${params.y})`}.\n${describeTab(tab)}`);
  },

  async type(params) {
    const tabId = await resolveTabId(params);
    if (params.ref) {
      const focused = await evalInPage(tabId, (ref) => {
        const el = document.querySelector(`[data-mcp-ref="${ref}"]`);
        if (!el) return null;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.focus();
        return document.activeElement === el || el.contains(document.activeElement);
      }, params.ref);
      if (focused === null) throw new Error(`Element ${params.ref} not found; call read_page again.`);
      if (!focused) {
        const { x, y } = await elementCenter(tabId, params.ref);
        await mouseClick(tabId, x, y);
      }
    }
    if (params.clear) {
      await evalInPage(tabId, () => {
        const el = document.activeElement;
        if (el && typeof el.select === 'function') el.select();
        else document.execCommand('selectAll');
      });
      await pressKey(tabId, 'Backspace');
    }
    if (params.text) await cdp(tabId, 'Input.insertText', { text: params.text });
    if (params.submit) await pressKey(tabId, 'Enter');
    return text(`Typed ${params.text.length} characters${params.ref ? ` into ${params.ref}` : ''}${params.submit ? ' and pressed Enter' : ''}.`);
  },

  async press_key(params) {
    const tabId = await resolveTabId(params);
    await pressKey(tabId, params.key);
    return text(`Pressed ${params.key}.`);
  },

  async scroll(params) {
    const tabId = await resolveTabId(params);
    if (params.ref) {
      await elementCenter(tabId, params.ref);
      return text(`Scrolled ${params.ref} into view.`);
    }
    const amount = params.amount || 600;
    const dir = params.direction || 'down';
    const deltaX = dir === 'left' ? -amount : dir === 'right' ? amount : 0;
    const deltaY = dir === 'up' ? -amount : dir === 'down' ? amount : 0;
    const vp = await evalInPage(tabId, () => ({ w: innerWidth, h: innerHeight }));
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: vp.w / 2, y: vp.h / 2, deltaX, deltaY });
    await sleep(400);
    const pos = await evalInPage(tabId, () => `${Math.round(scrollY)}/${Math.max(0, document.documentElement.scrollHeight - innerHeight)}`);
    return text(`Scrolled ${dir} ${amount}px. Page scroll position: ${pos}`);
  },

  async select_option(params) {
    const tabId = await resolveTabId(params);
    const chosen = await evalInPage(tabId, (ref, value) => {
      const el = document.querySelector(`[data-mcp-ref="${ref}"]`);
      if (!el) return { error: `Element ${ref} not found; call read_page again.` };
      if (el.tagName !== 'SELECT') return { error: `Element ${ref} is not a <select>. Click it and pick the option instead.` };
      const v = value.trim().toLowerCase();
      const opt = [...el.options].find((o) => o.value === value) ||
        [...el.options].find((o) => o.text.trim().toLowerCase() === v) ||
        [...el.options].find((o) => o.text.trim().toLowerCase().includes(v));
      if (!opt) return { error: `No option matching "${value}". Options: ${[...el.options].map((o) => o.text.trim()).join(' | ')}` };
      el.value = opt.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { text: opt.text.trim() };
    }, params.ref, String(params.value));
    if (chosen.error) throw new Error(chosen.error);
    return text(`Selected "${chosen.text}".`);
  },

  async upload_file(params) {
    const tabId = await resolveTabId(params);
    const { paths, ref } = params;
    const selector = ref ? `[data-mcp-ref="${ref}"]` : 'input[type=file]';
    const kind = await evalInPage(tabId, (selector) => {
      const el = document.querySelector(selector);
      if (!el) return 'missing';
      return el.tagName === 'INPUT' && el.type === 'file' ? 'input' : 'other';
    }, selector);
    if (kind === 'missing') {
      throw new Error(ref
        ? `Element ${ref} not found; call read_page again.`
        : 'No <input type=file> on this page. Pass the ref of the upload button or drop zone instead.');
    }
    await cdp(tabId, 'DOM.getDocument', { depth: 0 });

    if (kind === 'input') {
      const { result } = await cdp(tabId, 'Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})` });
      await cdp(tabId, 'DOM.setFileInputFiles', { files: paths, objectId: result.objectId });
    } else {
      // Not a file input: click it and catch the native file chooser it opens.
      await cdp(tabId, 'Page.enable');
      await cdp(tabId, 'Page.setInterceptFileChooserDialog', { enabled: true });
      try {
        const chooser = waitForEvent(tabId, 'Page.fileChooserOpened', 8000);
        chooser.catch(() => {});
        const { x, y } = await elementCenter(tabId, ref);
        await mouseClick(tabId, x, y);
        const ev = await chooser.catch(() => {
          throw new Error(`Clicking ${ref} did not open a file picker. Try another element, or a file input ref from read_page.`);
        });
        if (!ev.backendNodeId) throw new Error('The page opened a file picker that is not backed by an <input type=file>, so it cannot be filled.');
        await cdp(tabId, 'DOM.setFileInputFiles', { files: paths, backendNodeId: ev.backendNodeId });
      } finally {
        await cdp(tabId, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
      }
    }
    await sleep(500);
    const names = paths.map((p) => p.split(/[\\/]/).pop()).join(', ');
    return text(`Attached ${paths.length} file(s): ${names}. Check the page (read_page or screenshot) to confirm the upload was accepted.`);
  },

  async evaluate(params) {
    const tabId = await resolveTabId(params);
    const res = await cdp(tabId, 'Runtime.evaluate', {
      expression: params.code, returnByValue: true, awaitPromise: true, userGesture: true, replMode: true,
    });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    const v = res.result.value;
    let out = v === undefined ? (res.result.description || 'undefined') : JSON.stringify(v, null, 2);
    if (out.length > 20000) out = `${out.slice(0, 20000)}\n... [truncated]`;
    return text(out);
  },

  async wait_for(params) {
    if (params.ms && !params.text && !params.selector) {
      await sleep(Math.min(params.ms, 60000));
      return text(`Waited ${params.ms}ms.`);
    }
    const tabId = await resolveTabId(params);
    const timeout = params.timeout || 15000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = await evalInPage(tabId, (t, s) =>
        (s ? !!document.querySelector(s) : true) && (t ? document.body.innerText.includes(t) : true),
      params.text || '', params.selector || '').catch(() => false);
      if (found) return text(`Found after ${Date.now() - start}ms.`);
      await sleep(300);
    }
    throw new Error(`Timed out after ${timeout}ms waiting for ${params.selector ? `selector "${params.selector}"` : ''}${params.text ? ` text "${params.text}"` : ''}.`);
  },
};

function normalizeUrl(url) {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
}
