// Shared stdio JSON-RPC helper for exercising the REAL memoir MCP server
// (spawns `node src/mcp.js`, speaks newline-delimited JSON-RPC over stdio —
// the transport memoir actually uses in production, not a network server).
//
// Every spawned child gets a SCRATCH HOME/USERPROFILE (a fresh, empty temp
// dir) instead of inheriting the real process.env wholesale. This matters
// for any test beyond a bare tools/list: several tool handlers read/write
// ~/.config/memoir and ~/.claude, and a contract test must never be able to
// touch the real user's config or memory files.

import { spawn } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_ENTRY = path.join(__dirname, 'src', 'mcp.js');

/**
 * Create a fresh scratch HOME dir for a test run. Caller owns cleanup
 * (fs.remove(dir)) unless obtained implicitly via spawnMcpClient(), which
 * cleans up its own scratch home on close() when the caller didn't supply one.
 */
export async function makeScratchHome(prefix = 'memoir-mcp-test-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Build a sandboxed env for a spawned MCP child: scratch HOME/USERPROFILE,
 * NOT process.env spread wholesale. Carries over only what a Node child
 * needs to actually run (PATH + a couple of platform temp-dir vars).
 */
function sandboxedEnv(scratchHome, extra = {}) {
  return {
    PATH: process.env.PATH,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
    ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
    HOME: scratchHome,
    USERPROFILE: scratchHome, // Windows
    DO_NOT_TRACK: '1', // never emit telemetry from a test run
    ...extra,
  };
}

/**
 * Spawn a real `node src/mcp.js` child wired to a scratch HOME, and return a
 * small client to speak JSON-RPC over its stdio.
 *
 *   const mcp = await spawnMcpClient();
 *   await mcp.initialize();
 *   const tools = await mcp.listTools();
 *   const resources = await mcp.listResources();
 *   const result = await mcp.callTool('memoir_session', {});
 *   await mcp.close();
 */
export async function spawnMcpClient({ scratchHome, env = {}, timeoutMs = 15000 } = {}) {
  const home = scratchHome || (await makeScratchHome());
  const ownsHome = !scratchHome;

  const child = spawn(process.execPath, [MCP_ENTRY], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: sandboxedEnv(home, env),
  });

  let buf = '';
  let stderr = '';
  const pending = new Map(); // id -> { resolve, reject }
  let nextId = 1;
  let exited = false;

  child.stdout.on('data', (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`JSON-RPC error ${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    }
  });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.on('exit', () => {
    exited = true;
    for (const { reject } of pending.values()) {
      reject(new Error(`MCP server exited before responding. stderr: ${stderr}`));
    }
    pending.clear();
  });

  function request(method, params = {}) {
    if (exited) return Promise.reject(new Error(`MCP server already exited. stderr: ${stderr}`));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms. stderr: ${stderr}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  function notify(method, params = {}) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async function initialize() {
    const result = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'memoir-test', version: '0.0.0' },
    });
    notify('notifications/initialized', {});
    return result;
  }

  async function listTools() {
    const result = await request('tools/list', {});
    return result.tools;
  }

  /** Returns [] if the server doesn't implement resources/list (not an error). */
  async function listResources() {
    try {
      const result = await request('resources/list', {});
      return result.resources || [];
    } catch {
      return [];
    }
  }

  async function callTool(name, args = {}) {
    return request('tools/call', { name, arguments: args });
  }

  async function close() {
    try { child.kill('SIGKILL'); } catch {}
    if (ownsHome) { try { await fs.remove(home); } catch {} }
  }

  return {
    child, home,
    request, notify, initialize, listTools, listResources, callTool, close,
    getStderr: () => stderr,
  };
}
