import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readSafeFile, writeSafeFile } from '../security/files.js';
import { withSessionLock } from '../session/lock.js';

const serverPath = fileURLToPath(new URL('../mcp.js', import.meta.url));
const clients = {
  claude: { marker: '.claude', config: '.mcp.json' },
  codex: { marker: '.codex', config: '.codex/config.toml' },
  cursor: { marker: '.cursor', config: '.cursor/mcp.json' },
};

export async function verifyServer(project) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, MEMOIR_PROJECT_ROOT: project, DO_NOT_TRACK: '1' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'memoir-setup-check', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: 10000 });
    const { tools } = await client.listTools();
    for (const name of ['memoir_remember', 'memoir_recall', 'memoir_session']) {
      if (!tools.some(t => t.name === name)) throw new Error('Server is missing required tool: ' + name);
    }
    return true;
  } finally { await client.close(); }
}

// Project configuration supplies an explicit scope even for clients that
// launch all stdio servers with a home-directory working directory.
export async function setupIntegrations({ project = process.cwd(), tool = 'auto', check = true } = {}) {
  project = await fs.realpath(path.resolve(project));
  const selected = tool === 'all' ? Object.keys(clients) : tool === 'auto'
    ? Object.keys(clients).filter(name => fs.existsSync(path.join(os.homedir(), clients[name].marker)) || fs.existsSync(path.join(project, clients[name].config)))
    : tool.split(',').map(s => s.trim());
  if (selected.some(name => !clients[name])) throw new Error('Supported clients: claude, codex, cursor, all, auto');
  if (check && selected.length) await verifyServer(project);
  const results = [];
  for (const name of selected) {
    const relative = clients[name].config;
    const entry = { command: process.execPath, args: [serverPath], env: { MEMOIR_PROJECT_ROOT: project } };
    await withSessionLock(path.join(project, '.memoir-setup.lock'), async () => {
      let original = '';
      try { original = (await readSafeFile(project, relative)).toString('utf8'); }
      catch (err) { if (err.code !== 'ENOENT') throw err; }
      const toml = name === 'codex';
      const parsed = original.trim() ? (toml ? parseToml(original) : JSON.parse(original)) : {};
      const key = toml ? 'mcp_servers' : 'mcpServers';
      const existing = parsed[key]?.memoir;
      if (existing) {
        const matches = existing.command === entry.command && JSON.stringify(existing.args) === JSON.stringify(entry.args) && existing.env?.MEMOIR_PROJECT_ROOT === project;
        results.push({ tool: name, path: path.join(project, relative), status: matches ? 'ready' : 'existing-configuration', verified: matches && check });
        return;
      }
      let updated;
      if (toml) {
        // Preserve comments and unrelated formatting. Reject configurations
        // whose inline table cannot be extended rather than rewriting them.
        updated = original.trimEnd() + '\n\n' + stringifyToml({ mcp_servers: { memoir: entry } });
        parseToml(updated);
      } else {
        if (parsed[key] != null && (typeof parsed[key] !== 'object' || Array.isArray(parsed[key]))) throw new Error('Invalid MCP server configuration');
        parsed[key] = { ...(parsed[key] || {}), memoir: entry };
        updated = JSON.stringify(parsed, null, 2) + '\n';
      }
      if (original) await writeSafeFile(project, relative + '.memoir-backup', original);
      await writeSafeFile(project, relative, updated);
      results.push({ tool: name, path: path.join(project, relative), status: 'configured', verified: check });
    });
  }
  return results;
}

export async function setupCommand(options = {}) {
  const results = await setupIntegrations(options);
  if (!results.length) console.log('No supported clients detected. Use memoir setup --tool claude,codex,cursor to select them.');
  for (const result of results) console.log(result.tool + ': ' + result.status + ' — ' + result.path);
  if (results.some(r => r.status === 'existing-configuration')) console.log('Existing memoir entries were preserved. Review their command and project scope before using them.');
  if (results.length) console.log('The Memoir server passed its startup check. Restart the client and approve/trust its project MCP configuration when prompted.');
  return results;
}
