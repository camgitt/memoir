// "Is memoir actually being used?" — a pure summary over events.jsonl lines.
//
// The audit that motivated it (2026-09-04) had to grep Claude transcripts to
// learn that the store took 75 writes for every 10 reads in two weeks: the
// log recorded every write and sync but not one recall. Reads are logged
// since 3.13.0 (mcp_tool_used / cli_command, names only), so this can now
// answer from the log alone. Pure and synchronous: hand it lines, get counts.

const MCP_READS = new Set(['memoir_recall', 'memoir_why', 'memoir_read']);
const MCP_WRITES = new Set(['memoir_remember', 'memoir_note', 'memoir_add_next', 'memoir_complete_next', 'memoir_set_goal', 'memoir_forget', 'memoir_consolidate']);
const CLI_READS = new Set(['recall', 'why']);
const CLI_WRITES = new Set(['note', 'next', 'goal', 'done', 'forget', 'consolidate']);

export function emptySummary() {
  return {
    events: 0,
    reads: 0,
    writes: 0,
    by_tool: {},          // { memoir_recall: 9, ... } and CLI commands as 'cli:recall'
    decisions_captured: 0,
    next_completed: 0,
    next_parked: 0,
    goals_completed: 0,
    sync_pushed: 0,
    sync_failed: 0,
    sync_fail_reasons: {},
    sync_ms: [],          // durations of successful pushes that recorded one
    first_ts: null,
    last_ts: null,
  };
}

/**
 * @param {string[]|string} lines  events.jsonl content or its lines
 * @param {{ sinceMs?: number, now?: number }} opts  window (default: everything)
 */
export function summarizeEvents(lines, { sinceMs = 0, now = Date.now() } = {}) {
  const s = emptySummary();
  const cutoff = sinceMs > 0 ? now - sinceMs : 0;
  const arr = Array.isArray(lines) ? lines : String(lines || '').split('\n');
  for (const raw of arr) {
    const line = raw.trim();
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const t = Date.parse(e.ts || '');
    if (cutoff && (!Number.isFinite(t) || t < cutoff)) continue;
    s.events++;
    if (Number.isFinite(t)) {
      if (!s.first_ts || t < Date.parse(s.first_ts)) s.first_ts = e.ts;
      if (!s.last_ts || t > Date.parse(s.last_ts)) s.last_ts = e.ts;
    }
    switch (e.type) {
      case 'mcp_tool_used': {
        const tool = String(e.tool || '');
        s.by_tool[tool] = (s.by_tool[tool] || 0) + 1;
        if (MCP_READS.has(tool)) s.reads++;
        else if (MCP_WRITES.has(tool)) s.writes++;
        break;
      }
      case 'cli_command': {
        const cmd = String(e.command || '');
        const key = `cli:${cmd}`;
        s.by_tool[key] = (s.by_tool[key] || 0) + 1;
        if (CLI_READS.has(cmd)) s.reads++;
        else if (CLI_WRITES.has(cmd)) s.writes++;
        break;
      }
      case 'decision_captured': s.decisions_captured++; break;
      case 'next_completed': s.next_completed++; break;
      case 'next_parked': s.next_parked += Number(e.count) || 1; break;
      case 'goal_completed': s.goals_completed++; break;
      case 'sync_pushed':
        s.sync_pushed++;
        if (Number.isFinite(e.ms)) s.sync_ms.push(e.ms);
        break;
      case 'sync_failed': {
        s.sync_failed++;
        const r = String(e.reason || 'unrecorded');
        s.sync_fail_reasons[r] = (s.sync_fail_reasons[r] || 0) + 1;
        break;
      }
      default: break;
    }
  }
  return s;
}

export function median(nums) {
  if (!nums.length) return null;
  const a = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
}

/** Plain-text lines for `memoir status` (no colour; the caller styles). */
export function formatSummaryLines(s, { days = 7 } = {}) {
  const out = [];
  // Only tools that read or write memory make the top list — `push`,
  // `autopush`, `status` are plumbing, not usage.
  const isMemoryTool = (k) => k.startsWith('cli:') ? (CLI_READS.has(k.slice(4)) || CLI_WRITES.has(k.slice(4))) : (MCP_READS.has(k) || MCP_WRITES.has(k));
  const top = Object.entries(s.by_tool).filter(([k]) => isMemoryTool(k)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 4)
    .map(([k, v]) => `${k.replace(/^memoir_/, '').replace(/^cli:/, 'cli ')} ${v}`).join(', ');
  if (s.reads === 0 && s.writes === 0) {
    out.push(`Last ${days} days: no memory reads or writes recorded${s.events ? '' : ' (reads are logged since 3.13.0)'}`);
  } else {
    out.push(`Memory read ${s.reads}× · written ${s.writes}×${top ? `  (${top})` : ''}`);
  }
  if (s.sync_pushed || s.sync_failed) {
    const reasons = Object.entries(s.sync_fail_reasons).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, v]) => `${k} ${v}`).join(', ');
    const med = median(s.sync_ms);
    out.push(`Sync ${s.sync_pushed} ok / ${s.sync_failed} failed${reasons ? ` (${reasons})` : ''}${med != null ? ` · median ${(med / 1000).toFixed(1)}s` : ''}`);
  }
  const bits = [];
  if (s.decisions_captured) bits.push(`${s.decisions_captured} decision${s.decisions_captured === 1 ? '' : 's'} captured`);
  if (s.next_completed) bits.push(`${s.next_completed} next-action${s.next_completed === 1 ? '' : 's'} completed`);
  if (s.next_parked) bits.push(`${s.next_parked} parked`);
  if (s.goals_completed) bits.push(`${s.goals_completed} goal${s.goals_completed === 1 ? '' : 's'} retired`);
  if (bits.length) out.push(bits.join(' · '));
  return out;
}
