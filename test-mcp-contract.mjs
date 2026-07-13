#!/usr/bin/env node
// MCP tool-contract snapshot/regression test.
//
// Spawns the REAL memoir MCP server (src/mcp.js) over its real stdio
// transport, captures the full tools/list (name + description + complete
// inputSchema per tool) and resources/list, and diffs that against a
// checked-in golden fixture using EXACT-SET semantics: an added tool, a
// removed tool, a changed description, or a changed input schema all fail
// the diff — not just removals. This is a deliberate tripwire: any commit
// in this hardening pass that accidentally changes tool-visible behavior
// (a renamed param, a loosened/tightened schema, a reworded description)
// should fail this test, forcing a conscious decision rather than a silent
// drift.
//
// The spawned child runs with a SCRATCH HOME (see test-mcp-helpers.mjs) —
// it never touches the real user's ~/.config/memoir or ~/.claude.
//
// ── Regenerating the fixture (only for a LEGITIMATE tool-set change) ──────
//   UPDATE_SNAPSHOT=1 node test-mcp-contract.mjs
// This overwrites test-fixtures/mcp-tools.snapshot.json with the CURRENT
// live tool set. Only do this when you intend the tool list/schema to have
// changed — do not use it to make a failing test pass without understanding
// why it failed.
//
// ── Known wart in the captured shape (not a memoir bug, don't "fix" it) ───
// Every tool object also carries `execution: { taskSupport: "forbidden" }`
// and each inputSchema carries a `$schema` draft-07 URI. Both are boilerplate
// injected by the @modelcontextprotocol/sdk (McpServer + zod-to-json-schema
// conversion), not something memoir's tool definitions opt into. They're
// captured verbatim in the fixture (so an SDK bump that changes them still
// trips the tripwire, which is desired), but don't read them as meaningful
// memoir-authored coverage.

import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnMcpClient } from './test-mcp-helpers.mjs';

const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', CYAN = '\x1b[36m', RESET = '\x1b[0m';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ${GREEN}PASS${RESET} ${msg}`); pass++; }
  else      { console.log(`  ${RED}FAIL${RESET} ${msg}`); fail++; }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'test-fixtures', 'mcp-tools.snapshot.json');

console.log(`\n${BOLD}${CYAN}MCP tool-contract snapshot${RESET}\n`);

const mcp = await spawnMcpClient();
let captured = null;
let err = null;
try {
  await mcp.initialize();
  const tools = (await mcp.listTools()).slice().sort((a, b) => a.name.localeCompare(b.name));
  const resources = (await mcp.listResources()).slice().sort((a, b) => a.uri.localeCompare(b.uri));
  captured = { tools, resources };
} catch (e) {
  err = e;
} finally {
  await mcp.close();
}

assert(err === null, `spawned src/mcp.js and captured tools/list + resources/list without error${err ? ` (${err.message})` : ''}`);

if (captured) {
  if (process.env.UPDATE_SNAPSHOT === '1') {
    await fs.ensureDir(path.dirname(FIXTURE_PATH));
    await fs.writeJson(FIXTURE_PATH, captured, { spaces: 2 });
    console.log(`  ${CYAN}Wrote fixture${RESET} ${FIXTURE_PATH} (${captured.tools.length} tools, ${captured.resources.length} resources)`);
  }

  let golden = null;
  try {
    golden = await fs.readJson(FIXTURE_PATH);
  } catch (e) {
    assert(false, `golden fixture readable at ${FIXTURE_PATH} (${e.message})`);
  }

  if (golden) {
    // Exact-set on tool names: catches additions AND removals.
    const goldenNames = golden.tools.map(t => t.name).sort();
    const capturedNames = captured.tools.map(t => t.name).sort();
    assert(
      JSON.stringify(goldenNames) === JSON.stringify(capturedNames),
      `tool name set unchanged (golden: [${goldenNames.join(', ')}], captured: [${capturedNames.join(', ')}])`
    );

    // Per-tool deep-equality on description + inputSchema (catches renamed
    // params, loosened/tightened schemas, reworded descriptions).
    const goldenByName = new Map(golden.tools.map(t => [t.name, t]));
    for (const t of captured.tools) {
      const g = goldenByName.get(t.name);
      if (!g) continue; // already flagged by the name-set assertion above
      assert(g.description === t.description, `${t.name}: description unchanged`);
      assert(
        JSON.stringify(g.inputSchema) === JSON.stringify(t.inputSchema),
        `${t.name}: inputSchema unchanged`
      );
    }

    // Resources: same exact-set + content treatment.
    const goldenResUris = golden.resources.map(r => r.uri).sort();
    const capturedResUris = captured.resources.map(r => r.uri).sort();
    assert(
      JSON.stringify(goldenResUris) === JSON.stringify(capturedResUris),
      `resource uri set unchanged (golden: [${goldenResUris.join(', ')}], captured: [${capturedResUris.join(', ')}])`
    );
    const goldenResByUri = new Map(golden.resources.map(r => [r.uri, r]));
    for (const r of captured.resources) {
      const g = goldenResByUri.get(r.uri);
      if (!g) continue;
      assert(JSON.stringify(g) === JSON.stringify(r), `resource ${r.uri}: unchanged`);
    }

    // Whole-payload exact match as a final belt-and-suspenders check — this
    // is what actually enforces "exact-set", including catching a golden
    // fixture that has MORE tools/resources than are currently live.
    assert(
      JSON.stringify(golden) === JSON.stringify(captured),
      'full snapshot (tools+resources, sorted) byte-for-byte matches fixture'
    );
  }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
