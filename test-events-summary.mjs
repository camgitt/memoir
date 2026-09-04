#!/usr/bin/env node
// summarizeEvents is pure — no HOME shim needed, it never touches disk.
const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', CYAN = '\x1b[36m', RESET = '\x1b[0m';
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ${GREEN}PASS${RESET} ${msg}`); pass++; }
  else      { console.log(`  ${RED}FAIL${RESET} ${msg}`); fail++; }
}
const { summarizeEvents, formatSummaryLines, median } = await import('./src/events/summary.js');

console.log(`\n${BOLD}${CYAN}events/summary.js${RESET}\n`);
const now = Date.parse('2026-09-04T12:00:00Z');
const day = 24 * 60 * 60 * 1000;
const at = (d) => new Date(now - d * day).toISOString();
const ev = (o) => JSON.stringify({ machine_id: 'm', ...o });
const lines = [
  ev({ ts: at(1), type: 'mcp_tool_used', tool: 'memoir_recall' }),
  ev({ ts: at(1), type: 'mcp_tool_used', tool: 'memoir_recall' }),
  ev({ ts: at(2), type: 'mcp_tool_used', tool: 'memoir_remember' }),
  ev({ ts: at(2), type: 'mcp_tool_used', tool: 'memoir_add_next' }),
  ev({ ts: at(2), type: 'mcp_tool_used', tool: 'memoir_status' }),      // neither read nor write
  ev({ ts: at(3), type: 'cli_command', command: 'why' }),
  ev({ ts: at(3), type: 'cli_command', command: 'push' }),             // neither
  ev({ ts: at(3), type: 'decision_captured', has_why: true }),
  ev({ ts: at(3), type: 'next_parked', count: 2 }),
  ev({ ts: at(4), type: 'sync_pushed', provider: 'git', ms: 9000 }),
  ev({ ts: at(4), type: 'sync_pushed', provider: 'git', ms: 3000 }),
  ev({ ts: at(4), type: 'sync_pushed', provider: 'git' }),             // old shape, no ms
  ev({ ts: at(5), type: 'sync_failed', provider: 'git', reason: 'timeout' }),
  ev({ ts: at(5), type: 'sync_failed', provider: 'git' }),             // old shape, no reason
  ev({ ts: at(20), type: 'mcp_tool_used', tool: 'memoir_recall' }),     // outside a 7-day window
  'not json at all',
  '',
];
const s = summarizeEvents(lines, { sinceMs: 7 * day, now });
assert(s.reads === 3, `reads = 2 recall + 1 cli why (${s.reads})`);
assert(s.writes === 2, `writes = remember + add_next (${s.writes})`);
assert(s.by_tool.memoir_recall === 2 && s.by_tool['cli:why'] === 1, 'by_tool counts MCP tools and CLI commands');
assert(s.decisions_captured === 1 && s.next_parked === 2, 'decision + parked counts (parked uses count field)');
assert(s.sync_pushed === 3 && s.sync_failed === 2, 'sync counts include old-shape events');
assert(s.sync_fail_reasons.timeout === 1 && s.sync_fail_reasons.unrecorded === 1, 'failure reasons, old shape → unrecorded');
assert(JSON.stringify(s.sync_ms) === '[9000,3000]', 'only pushes that recorded ms contribute durations');
assert(s.events === 14, `window excludes the 20-day-old event and junk lines (${s.events})`);
assert(median([9000, 3000]) === 6000 && median([]) === null && median([1, 5, 9]) === 5, 'median');
const out = formatSummaryLines(s, { days: 7 });
assert(out[0] === 'Memory read 3× · written 2×  (recall 2, cli why 1, memoir_add_next 1, remember 1)'.replace('memoir_add_next', 'add_next'), `usage line (plumbing like status/push excluded, ties alphabetical): ${out[0]}`);
assert(out[1] === 'Sync 3 ok / 2 failed (timeout 1, unrecorded 1) · median 6.0s', `sync line: ${out[1]}`);
assert(out[2] === '1 decision captured · 2 parked', `activity line: ${out[2]}`);
const empty = formatSummaryLines(summarizeEvents([], { sinceMs: 7 * day, now }));
assert(empty[0].includes('no memory reads or writes recorded') && empty[0].includes('since 3.13.0'), 'empty log explains itself');
const all = summarizeEvents(lines, { now });
assert(all.reads === 4, 'no window → everything counts');

console.log(`\n${BOLD}${pass} passed, ${fail} failed${RESET}\n`);
process.exit(fail ? 1 : 0);
