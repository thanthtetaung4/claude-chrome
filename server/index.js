#!/usr/bin/env node
// MCP server (stdio) <-> WebSocket bridge to the Claude Browser Bridge Chrome extension.
// Claude Desktop launches this process; the extension connects to ws://127.0.0.1:PORT.
import { WebSocketServer, WebSocket } from 'ws';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.BROWSER_BRIDGE_PORT || 18765);
const VERSION = '1.0.0';
const log = (...args) => process.stderr.write(`[browser-bridge] ${args.join(' ')}\n`);

// ---------------------------------------------------------------- extension link
// Claude Desktop may launch several copies of this server. The first one to bind
// the port owns the extension connection ("primary"); the others relay their
// commands to it over the same port, and take over if it exits.
const NOT_CONNECTED =
  'Chrome extension is not connected. Make sure Chrome is open and the "Claude Browser Bridge" extension is enabled ' +
  '(its toolbar badge shows ON when connected).';

let ext = null;
let relay = null;
let isPrimary = false;
let nextId = 1;
const pending = new Map();

function onResponse(data) {
  let msg;
  try { msg = JSON.parse(data.toString()); } catch { return; }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  clearTimeout(p.timer);
  if (msg.error) p.reject(new Error(msg.error));
  else p.resolve(msg.result);
}

function rejectPendingOn(socket, reason) {
  for (const [id, p] of pending) {
    if (p.socket !== socket) continue;
    pending.delete(id);
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
}

function startWebSocketServer() {
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: PORT,
    // Browser extensions, or relays from sibling server processes. Web pages can't
    // forge the Origin header or add custom headers to a WebSocket handshake.
    verifyClient: ({ origin, req }) =>
      (typeof origin === 'string' && origin.startsWith('chrome-extension://')) ||
      (!origin && req.headers['x-bridge-relay'] === '1'),
  });
  wss.on('listening', () => { isPrimary = true; log(`waiting for extension on ws://127.0.0.1:${PORT}`); });
  wss.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') log(`websocket server error: ${err.code || err.message}`);
    setTimeout(startWebSocketServer, 3000);
  });
  wss.on('connection', (ws, req) => {
    if (req.headers['x-bridge-relay'] === '1') {
      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        callExtension(msg.method, msg.params)
          .then((result) => ws.send(JSON.stringify({ id: msg.id, result })))
          .catch((err) => ws.send(JSON.stringify({ id: msg.id, error: err.message })));
      });
      return;
    }
    if (ext && ext !== ws) ext.close(1000, 'replaced by newer connection');
    ext = ws;
    log('extension connected');
    ws.on('message', onResponse);
    ws.on('close', () => {
      if (ext === ws) ext = null;
      rejectPendingOn(ws, 'The browser extension disconnected before replying.');
      log('extension disconnected');
    });
  });
}

// App-level heartbeat keeps the extension's MV3 service worker alive.
setInterval(() => {
  if (ext && ext.readyState === 1) ext.send(JSON.stringify({ type: 'ping' }));
}, 20000).unref();

function getRelay() {
  if (relay && relay.readyState === 1) return Promise.resolve(relay);
  return new Promise((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { 'x-bridge-relay': '1' } });
    s.on('open', () => { relay = s; resolve(s); });
    s.on('error', () => reject(new Error(NOT_CONNECTED)));
    s.on('message', onResponse);
    s.on('close', () => {
      if (relay === s) relay = null;
      rejectPendingOn(s, 'Lost connection to the primary browser-bridge process; try again.');
    });
  });
}

function request(socket, method, params, timeoutMs) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out after ${timeoutMs / 1000}s waiting for the browser (${method}).`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, socket });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function callExtension(method, params, timeoutMs = 90000) {
  if (ext && ext.readyState === 1) return request(ext, method, params, timeoutMs);
  if (isPrimary) throw new Error(NOT_CONNECTED);
  return request(await getRelay(), method, params, timeoutMs + 5000);
}

// ---------------------------------------------------------------- tool definitions
const tabId = { type: 'number', description: 'Tab id from list_tabs. Defaults to the active tab.' };
const ref = { type: 'string', description: 'Element ref from read_page, e.g. "e12".' };

const TOOLS = [
  {
    name: 'list_tabs',
    description: 'List open browser tabs with their ids, titles and URLs.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'new_tab',
    description: 'Open a new tab (optionally at a URL), make it active, and wait for it to load.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
  },
  {
    name: 'switch_tab',
    description: 'Activate a tab so later commands default to it.',
    inputSchema: { type: 'object', properties: { tabId }, required: ['tabId'] },
  },
  {
    name: 'close_tab',
    description: 'Close a tab.',
    inputSchema: { type: 'object', properties: { tabId }, required: ['tabId'] },
  },
  {
    name: 'navigate',
    description: 'Navigate a tab to a URL and wait for it to load. Use "back", "forward" or "reload" as the url for history actions.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, tabId }, required: ['url'] },
  },
  {
    name: 'screenshot',
    description: 'Take a screenshot of the visible part of a tab. Pixel coordinates in the image can be passed to click(x, y).',
    inputSchema: { type: 'object', properties: { tabId } },
  },
  {
    name: 'read_page',
    description:
      'List interactive elements on the page (links, buttons, inputs, file inputs, selects...) with refs like [e12] ' +
      'that other tools accept. Also returns the URL and title. Prefer this over screenshots for finding things to click.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        filter: { type: 'string', description: 'Only return elements whose description contains this text (case-insensitive).' },
        viewportOnly: { type: 'boolean', description: 'Only elements currently visible on screen (default false).' },
      },
    },
  },
  {
    name: 'get_text',
    description: 'Get the readable text content of the page (or of one element).',
    inputSchema: {
      type: 'object',
      properties: { tabId, ref, maxChars: { type: 'number', description: 'Default 30000.' } },
    },
  },
  {
    name: 'click',
    description: 'Click an element by ref, or at x/y pixel coordinates taken from a screenshot. Uses real mouse events.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId, ref,
        x: { type: 'number' }, y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        double: { type: 'boolean', description: 'Double-click.' },
      },
    },
  },
  {
    name: 'type',
    description: 'Type text into an element (ref) or into whatever currently has focus.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId, ref,
        text: { type: 'string' },
        clear: { type: 'boolean', description: 'Clear the existing value first.' },
        submit: { type: 'boolean', description: 'Press Enter after typing.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'press_key',
    description: 'Press a key or shortcut, e.g. "Enter", "Escape", "Tab", "ArrowDown", "Control+a", "Shift+Tab".',
    inputSchema: { type: 'object', properties: { tabId, key: { type: 'string' } }, required: ['key'] },
  },
  {
    name: 'scroll',
    description: 'Scroll the page. Give a direction, or a ref to scroll that element into view.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId, ref,
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'number', description: 'Pixels (default 600).' },
      },
    },
  },
  {
    name: 'select_option',
    description: 'Choose an option in a <select> element by its value or visible text.',
    inputSchema: { type: 'object', properties: { tabId, ref, value: { type: 'string' } }, required: ['ref', 'value'] },
  },
  {
    name: 'upload_file',
    description:
      'Upload local file(s) from this computer into the page. `ref` may be a file input from read_page, or the ' +
      'button/drop-zone that normally opens the file picker (the picker is intercepted and filled automatically). ' +
      'Without a ref, the first file input on the page is used. Paths must be absolute local paths, e.g. C:\\Users\\me\\resume.pdf.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId, ref,
        paths: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths.' },
      },
      required: ['paths'],
    },
  },
  {
    name: 'evaluate',
    description: 'Run JavaScript in the page and return the (JSON-serialisable) result. Promises are awaited.',
    inputSchema: { type: 'object', properties: { tabId, code: { type: 'string' } }, required: ['code'] },
  },
  {
    name: 'wait_for',
    description: 'Wait for text or a CSS selector to appear on the page, or simply wait `ms` milliseconds.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        text: { type: 'string' },
        selector: { type: 'string' },
        ms: { type: 'number' },
        timeout: { type: 'number', description: 'Max wait in ms (default 15000).' },
      },
    },
  },
];

async function runTool(name, args) {
  if (!TOOLS.some((t) => t.name === name)) throw new Error(`Unknown tool: ${name}`);
  if (name === 'upload_file') {
    if (!Array.isArray(args.paths) || args.paths.length === 0) throw new Error('paths must be a non-empty array.');
    args = { ...args, paths: args.paths.map((p) => {
      const abs = path.resolve(p.replace(/^~(?=$|[\\/])/, process.env.USERPROFILE || process.env.HOME || '~'));
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`File not found: ${abs}`);
      return abs;
    }) };
  }
  // The extension returns MCP content blocks directly.
  return callExtension(name, args || {});
}

// ---------------------------------------------------------------- MCP stdio (JSON-RPC, newline-delimited)
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  try {
    switch (method) {
      case 'initialize':
        return send({ jsonrpc: '2.0', id, result: {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'claude-browser-bridge', version: VERSION },
          instructions:
            'Controls the user\'s real Chrome browser. Typical flow: list_tabs or new_tab -> read_page to get element refs -> ' +
            'click/type/upload_file using refs -> read_page or screenshot to verify.',
        } });
      case 'ping':
        return send({ jsonrpc: '2.0', id, result: {} });
      case 'tools/list':
        return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      case 'tools/call': {
        try {
          const content = await runTool(params.name, params.arguments || {});
          return send({ jsonrpc: '2.0', id, result: { content } });
        } catch (err) {
          return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true } });
        }
      }
      default:
        return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: err.message } });
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return log('ignoring non-JSON input'); }
  handle(msg);
});
process.stdin.on('end', () => process.exit(0));

startWebSocketServer();
