// Render session state → pinned markdown block.
// The block is wrapped in <!-- memoir:session-block v1 --> markers so inject.js
// can find and replace it without touching anything else in CLAUDE.md.

export const BLOCK_START = '<!-- memoir:session-block v1 — managed by memoir, edit via `memoir goal/next/note` -->';
export const BLOCK_END = '<!-- /memoir:session-block -->';

const MAX_RENDERED_GOALS = 2;
const MAX_RENDERED_NEXT = 6;
const MAX_RENDERED_QUESTIONS = 4;
const MAX_RENDERED_DECISIONS = 5;
const MAX_RENDERED_HISTORY = 5;

export function renderSession(state) {
  if (!state) return renderEmpty();

  const lines = [BLOCK_START, '## 🎯 Continuing from where we left off', ''];

  const goals = (state.current?.goals || []).slice(0, MAX_RENDERED_GOALS);
  const nexts = (state.current?.next_actions || []).slice(-MAX_RENDERED_NEXT).reverse();
  const questions = (state.current?.open_questions || []).slice(-MAX_RENDERED_QUESTIONS).reverse();
  const decisions = (state.current?.decisions || []).slice(0, MAX_RENDERED_DECISIONS);
  const history = (state.history || []).slice(0, MAX_RENDERED_HISTORY);

  const everythingEmpty = !goals.length && !nexts.length && !questions.length && !decisions.length && !history.length;
  if (everythingEmpty) return renderEmpty();

  // Goals — show current goal prominently
  if (goals.length === 1) {
    lines.push(`**Current goal:** ${goals[0].text}${machineTag(goals[0], state)}`);
    lines.push('');
  } else if (goals.length > 1) {
    lines.push('**Goals:**');
    for (const g of goals) lines.push(`- ${g.text}${machineTag(g, state)}`);
    lines.push('');
  }

  // Next actions — checkbox format so they read as actionable
  if (nexts.length) {
    lines.push('**Next:**');
    for (const n of nexts) {
      lines.push(`- [ ] ${n.text}${machineTag(n, state)}`);
    }
    lines.push('');
  }

  // Open questions
  if (questions.length) {
    lines.push('**Open questions:**');
    for (const q of questions) lines.push(`- ${q.text}${machineTag(q, state)}`);
    lines.push('');
  }

  // Recent decisions
  if (decisions.length) {
    lines.push('**Recent decisions:**');
    for (const d of decisions) {
      let line = `- ${d.text}`;
      if (d.why) line += ` — *${d.why}*`;
      line += machineTag(d, state);
      lines.push(line);
    }
    lines.push('');
  }

  // Recent session history — machine-tagged so user sees cross-machine trail
  if (history.length) {
    lines.push('**Recent sessions:**');
    for (const h of history) {
      const date = (h.date || '').slice(0, 10);
      const machineLabel = labelFor(h.machine_id, state) || 'unknown';
      const dur = h.duration_min ? ` (${formatDuration(h.duration_min)})` : '';
      const summary = h.summary || '—';
      lines.push(`- ${date} ${machineLabel}${dur}: ${summary}`);
    }
    lines.push('');
  }

  lines.push(BLOCK_END);
  return lines.join('\n');
}

function machineTag(item, state) {
  if (!item?.machine_id) return '';
  const label = labelFor(item.machine_id, state);
  // Only show machine tag if we have more than one machine — otherwise it's noise
  const machineCount = Object.keys(state?.machines || {}).length;
  if (machineCount <= 1 || !label) return '';
  return ` _(${label})_`;
}

function labelFor(machineId, state) {
  if (!machineId) return null;
  return state?.machines?.[machineId]?.label || null;
}

function formatDuration(min) {
  if (!min || min <= 0) return '';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function renderEmpty() {
  return [
    BLOCK_START,
    '## 🎯 Continuing from where we left off',
    '',
    '_No session context yet. Set one with:_ `memoir goal "your current focus"`',
    '',
    BLOCK_END,
  ].join('\n');
}
