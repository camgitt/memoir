#!/usr/bin/env node
// Locks the MCP Registry listing contract: server.json must stay on the
// official schema, use the io.github.camgitt namespace, stay in lockstep
// with package.json, and point packages[] at the npm package memoir-cli.
// The registry verifies npm ownership via package.json's mcpName field.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', CYAN = '\x1b[36m', RESET = '\x1b[0m';
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ${GREEN}PASS${RESET} ${msg}`); pass++; }
  else { console.log(`  ${RED}FAIL${RESET} ${msg}`); fail++; }
}

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const server = JSON.parse(fs.readFileSync(path.join(root, 'server.json'), 'utf8'));

const SCHEMA = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';
const NAME = 'io.github.camgitt/memoir';
const NAME_RE = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;

console.log(`\n${BOLD}${CYAN}server.json / mcpName registry contract${RESET}\n`);

assert(pkg.mcpName === NAME, `package.json mcpName is ${NAME}`);
assert(server.name === NAME, `server.json name is ${NAME}`);
assert(server.name === pkg.mcpName, 'server.json name matches package.json mcpName');
assert(NAME_RE.test(server.name), 'server.json name matches reverse-DNS / name pattern');
assert(server.name.startsWith('io.github.camgitt/'), 'server.json name is under the GitHub OIDC namespace');

assert(server.$schema === SCHEMA, `server.json $schema is the 2025-12-11 official schema`);
assert(typeof server.version === 'string' && server.version.length > 0, 'server.json has a version');
assert(server.version !== 'latest', 'server.json version is not the rejected sentinel "latest"');
assert(server.version === pkg.version, `server.json version matches package.json (${pkg.version})`);

assert(typeof server.description === 'string' && server.description.length >= 1, 'server.json has a description');
assert(server.description.length <= 100, `server.json description is ≤100 chars (got ${server.description.length})`);

assert(server.repository?.source === 'github', 'server.json repository.source is github');
assert(server.repository?.url === 'https://github.com/camgitt/memoir', 'server.json repository.url is this repo');

assert(Array.isArray(server.packages) && server.packages.length === 1, 'server.json has exactly one packages[] entry');
const pack = server.packages[0];
assert(pack.registryType === 'npm', 'packages[0].registryType is npm');
assert(pack.identifier === 'memoir-cli', 'packages[0].identifier is memoir-cli');
assert(pack.identifier === pkg.name, 'packages[0].identifier matches package.json name');
assert(pack.version === pkg.version, `packages[0].version matches package.json (${pkg.version})`);
assert(pack.transport?.type === 'stdio', 'packages[0].transport.type is stdio');

console.log(`\n${BOLD}${fail === 0 ? GREEN : RED}${fail === 0 ? 'ALL' : fail} ${fail === 0 ? pass + ' SERVER.JSON CHECKS PASSED' : 'FAILED'}${RESET}\n`);
process.exit(fail === 0 ? 0 : 1);
