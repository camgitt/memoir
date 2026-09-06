// `memoir validate` — structural conformance checks for the memoir format.
//
// docs/SPEC.md (v0.1 draft) is the normative text; schema/*.schema.json is
// the machine-readable mirror. The checks here are hand-rolled on purpose:
// no JSON Schema engine dependency for a format this small, and the few
// checks that matter (required fields, date sanity, tombstone invariants)
// stay readable as plain code.
//
//   memoir validate                 validate the live session.json
//   memoir validate <file.md> ...   validate entry files
//   memoir validate <dir>           validate every *.md under dir
//                                   (+ its session.json, if present)
//   memoir validate --strict        warnings count as failures
//
// Severity model:
//   error   — violates a MUST in SPEC.md; the file fails.
//   warning — violates a SHOULD, or a legacy (pre-v0.1) dialect that
//             readers must tolerate but writers must not emit.
// Exit code is 1 when any error occurred (or any warning, with --strict).

import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { paths } from '../session/state.js';
import { SCHEMA_VERSION } from '../session/migrations.js';

const ENTRY_TYPES = ['fact', 'preference', 'decision', 'lesson', 'goal', 'next_action'];

// Pre-v0.1 type vocabulary (SPEC.md Appendix A) — accepted with a warning.
const LEGACY_TYPES = {
  user: 'preference',
  feedback: 'lesson',
  reference: 'fact',
  project: null, // dossier — no atomic mapping; read as opaque legacy entry
};

// Frontmatter date-ish fields, checked for ISO 8601 shape when present.
const DATE_FIELDS = ['created', 'updated', 'date', 'set_on', 'added', 'done_at', 'hidden_at', 'last_fired'];

// ── Frontmatter parsing (restricted YAML subset per SPEC.md 3.1) ──
//
// Supports: scalar `key: value`, one level of nested mapping, and simple
// `- item` string lists. That is all the format allows in frontmatter, so
// that is all this parses. Not a general YAML parser and not meant to be.

function parseScalar(raw) {
  let v = String(raw).trim();
  if (v.startsWith('"') && v.endsWith('"')) {
    try { return JSON.parse(v); } catch {}
  }
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
  ) {
    v = v.slice(1, -1);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  return v;
}

export function parseFrontmatter(raw) {
  const lines = String(raw).split(/\r?\n/);
  if ((lines[0] || '').trim() !== '---') {
    return { present: false, fields: {}, body: raw, error: null };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) {
    return { present: true, fields: {}, body: raw, error: 'unterminated frontmatter (no closing ---)' };
  }

  const fields = {};
  let openKey = null; // most recent top-level key whose value may nest
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (/^\s/.test(line) && openKey) {
      // One level of nesting under openKey: nested map entry or list item.
      if (trimmed.startsWith('- ')) {
        if (!Array.isArray(fields[openKey])) fields[openKey] = [];
        fields[openKey].push(parseScalar(trimmed.slice(2)));
      } else {
        const m = trimmed.match(/^([^:]+):\s*(.*)$/);
        if (m) {
          if (typeof fields[openKey] !== 'object' || fields[openKey] === null || Array.isArray(fields[openKey])) {
            fields[openKey] = {};
          }
          fields[openKey][m[1].trim()] = parseScalar(m[2]);
        }
      }
      continue;
    }

    const m = line.match(/^([^:\s][^:]*):\s*(.*)$/);
    if (!m) continue; // tolerate lines we don't understand — validation reports, not parsing, is the job
    const key = m[1].trim();
    if (m[2] === '') {
      openKey = key;
      fields[key] = '';
    } else {
      openKey = null;
      fields[key] = parseScalar(m[2]);
    }
  }

  return { present: true, fields, body: lines.slice(end + 1).join('\n'), error: null };
}

// ── Shared checks ────────────────────────────────────────────────

function isIsoDateString(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(new Date(v).getTime());
}

// ── Entry file validation (SPEC.md section 3, entry.schema.json) ──

export function validateEntry(raw) {
  const errors = [];
  const warnings = [];
  const { present, fields, body, error } = parseFrontmatter(raw);

  if (!present) {
    warnings.push('no frontmatter — legacy bare-markdown entry (SPEC.md Appendix A); readers treat as opaque, writers must not emit this');
    return { errors, warnings };
  }
  if (error) {
    errors.push(error);
    return { errors, warnings };
  }

  // Resolve type across dialects: canonical top-level `type`, legacy `metadata.type`.
  let type = fields.type;
  if (type == null && fields.metadata && typeof fields.metadata === 'object' && fields.metadata.type != null) {
    type = fields.metadata.type;
    warnings.push('legacy dialect: type nested under metadata (canonical: top-level `type`)');
  }

  if (!fields.name || typeof fields.name !== 'string' || !String(fields.name).trim()) {
    errors.push('missing required field: name');
  }
  if (!fields.description) {
    warnings.push('missing description (SHOULD) — entry is invisible in indexes and pickers');
  }

  if (type == null) {
    errors.push(`missing required field: type (one of: ${ENTRY_TYPES.join(', ')})`);
  } else if (ENTRY_TYPES.includes(type)) {
    validateCanonicalType(type, fields, body, errors, warnings);
  } else if (type in LEGACY_TYPES) {
    const mapped = LEGACY_TYPES[type];
    warnings.push(`legacy type "${type}"${mapped ? ` (reads as ${mapped})` : ' (dossier — no atomic mapping)'} — canonical types: ${ENTRY_TYPES.join(', ')}`);
    if (type === 'feedback' && !/\*\*How to apply:?\*\*/i.test(body)) {
      warnings.push('legacy feedback entry without a **How to apply:** body section — lesson has no application rule');
    }
  } else {
    errors.push(`unknown type "${type}" — canonical: ${ENTRY_TYPES.join(', ')}; legacy (read-only): ${Object.keys(LEGACY_TYPES).join(', ')}`);
  }

  for (const f of DATE_FIELDS) {
    if (fields[f] != null && !isIsoDateString(fields[f])) {
      errors.push(`field ${f} is not an ISO 8601 date: ${JSON.stringify(fields[f])}`);
    }
  }
  if (fields.schema_version != null && (!Number.isInteger(fields.schema_version) || fields.schema_version < 1)) {
    errors.push(`schema_version must be a positive integer, got ${JSON.stringify(fields.schema_version)}`);
  }
  if (Number.isInteger(fields.schema_version) && fields.schema_version > 1) {
    warnings.push(`schema_version ${fields.schema_version} is newer than this build understands (v1) — forward-version rule applies: quarantine + degrade, never guess (SPEC.md section 6)`);
  }

  return { errors, warnings };
}

function validateCanonicalType(type, fields, body, errors, warnings) {
  if (type === 'decision') {
    if (!fields.why) warnings.push('decision without a why (required-encouraged) — a decision without a why is half a decision');
    if (!fields.rejected) warnings.push('decision without a rejected alternative (required-encouraged)');
    if (fields.hidden === true && !fields.hidden_at) {
      errors.push('hidden: true without hidden_at — tombstones must carry when they were set (SPEC.md 5.3.1)');
    }
  } else if (type === 'lesson') {
    if (!fields.trigger) {
      errors.push('lesson missing required field: trigger — when does this lesson apply?');
    }
    if (!fields.how_to_apply) {
      if (/\*\*How to apply:?\*\*/i.test(body)) {
        warnings.push('how_to_apply lives in the body (**How to apply:** section) — accepted for legacy entries; canonical form is the frontmatter key');
      } else {
        errors.push('lesson missing required field: how_to_apply — without an application rule it is an anecdote, not a lesson');
      }
    }
    if (fields.fired_count != null && (!Number.isInteger(fields.fired_count) || fields.fired_count < 0)) {
      errors.push(`fired_count must be a non-negative integer, got ${JSON.stringify(fields.fired_count)}`);
    }
  } else if (type === 'next_action') {
    if (!fields.added) {
      errors.push('next_action missing required field: added — completion semantics (done_at vs added) are undefined without it');
    }
    if (isIsoDateString(fields.added) && isIsoDateString(fields.done_at) && new Date(fields.done_at) < new Date(fields.added)) {
      warnings.push('done_at is earlier than added — this action was completed before it existed');
    }
  } else if (type === 'preference') {
    if (fields.scope != null && !['global', 'project'].includes(fields.scope)) {
      warnings.push(`preference scope should be "global" or "project", got ${JSON.stringify(fields.scope)}`);
    }
  }
  // fact, goal: no extra required fields.
}

// ── Session file validation (SPEC.md section 4, session.schema.json) ──

function checkListItems(list, listName, dateField, errors, warnings) {
  if (!Array.isArray(list)) {
    errors.push(`current.${listName} must be an array`);
    return;
  }
  list.forEach((item, i) => {
    const at = `current.${listName}[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${at} must be an object`);
      return;
    }
    if (typeof item.text !== 'string' || !item.text.trim()) {
      errors.push(`${at} missing required field: text (the merge identity key)`);
    }
    if (item[dateField] != null && !isIsoDateString(item[dateField])) {
      errors.push(`${at}.${dateField} is not an ISO 8601 date-time: ${JSON.stringify(item[dateField])}`);
    }
    if (item[dateField] == null) {
      warnings.push(`${at} missing ${dateField} — merges treat a missing date as the epoch (always loses newest-wins)`);
    }
  });
}

export function validateSessionObject(obj) {
  const errors = [];
  const warnings = [];

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    errors.push('session must be a JSON object');
    return { errors, warnings };
  }

  if (!Number.isInteger(obj.version) || obj.version < 1) {
    errors.push(`version must be a positive integer, got ${JSON.stringify(obj.version)}`);
  } else if (obj.version > SCHEMA_VERSION) {
    warnings.push(`version ${obj.version} is newer than this build understands (v${SCHEMA_VERSION}) — forward-version rule applies: quarantine + degrade, never guess (SPEC.md section 6)`);
  }

  for (const f of ['created_at', 'updated_at']) {
    if (obj[f] == null) errors.push(`missing required field: ${f}`);
    else if (!isIsoDateString(obj[f])) errors.push(`${f} is not an ISO 8601 date-time: ${JSON.stringify(obj[f])}`);
  }

  if (!obj.machines || typeof obj.machines !== 'object' || Array.isArray(obj.machines)) {
    errors.push('missing required field: machines (object of machine-uuid -> { label, last_seen })');
  } else {
    for (const [id, m] of Object.entries(obj.machines)) {
      if (!m || typeof m !== 'object') { errors.push(`machines["${id}"] must be an object`); continue; }
      if (typeof m.label !== 'string') errors.push(`machines["${id}"] missing required field: label`);
      if (!isIsoDateString(m.last_seen)) errors.push(`machines["${id}"].last_seen is not an ISO 8601 date-time`);
    }
  }

  const cur = obj.current;
  if (!cur || typeof cur !== 'object' || Array.isArray(cur)) {
    errors.push('missing required field: current');
  } else {
    checkListItems(cur.goals, 'goals', 'set_on', errors, warnings);
    checkListItems(cur.next_actions, 'next_actions', 'added', errors, warnings);
    checkListItems(cur.open_questions, 'open_questions', 'asked', errors, warnings);
    checkListItems(cur.decisions, 'decisions', 'date', errors, warnings);
    (Array.isArray(cur.decisions) ? cur.decisions : []).forEach((d, i) => {
      if (d && d.hidden === true && !isIsoDateString(d.hidden_at)) {
        errors.push(`current.decisions[${i}] hidden: true without a valid hidden_at (SPEC.md 5.3.1)`);
      }
      // Purged form: text_hash only makes sense on a hidden tombstone whose
      // text is the [purged] literal; a hash on a live decision is not an identity.
      if (d && d.text_hash != null) {
        if (!/^[0-9a-f]{64}$/.test(String(d.text_hash))) {
          errors.push(`current.decisions[${i}] text_hash must be lowercase hex SHA-256 (SPEC.md 5.3.1)`);
        }
        if (d.hidden !== true) {
          errors.push(`current.decisions[${i}] text_hash without hidden: true — purge implies hide (SPEC.md 5.3.1)`);
        }
        if (d.text !== '[purged]') {
          warnings.push(`current.decisions[${i}] carries text_hash but text is not "[purged]" — the redacted text may still be present`);
        }
      }
    });
    // completed_actions is optional (absent = empty), but when present its
    // tombstones must be well-formed or the temporal merge rule breaks.
    if (cur.completed_actions != null) {
      if (!Array.isArray(cur.completed_actions)) {
        errors.push('current.completed_actions must be an array when present');
      } else {
        cur.completed_actions.forEach((t, i) => {
          const at = `current.completed_actions[${i}]`;
          if (!t || typeof t !== 'object') { errors.push(`${at} must be an object`); return; }
          if (typeof t.text !== 'string' || !t.text.trim()) errors.push(`${at} missing required field: text`);
          if (!isIsoDateString(t.done_at)) errors.push(`${at} missing/invalid required field: done_at (the tombstone is meaningless without it)`);
        });
      }
    }
  }

  if (!Array.isArray(obj.history)) {
    errors.push('missing required field: history (array)');
  } else {
    obj.history.forEach((h, i) => {
      if (!h || typeof h !== 'object') { errors.push(`history[${i}] must be an object`); return; }
      if (!isIsoDateString(h.date)) errors.push(`history[${i}] missing/invalid required field: date`);
      if (h.files_touched != null && !Array.isArray(h.files_touched)) errors.push(`history[${i}].files_touched must be an array`);
      if (h.duration_min != null && typeof h.duration_min !== 'number') errors.push(`history[${i}].duration_min must be a number or null`);
    });
  }

  return { errors, warnings };
}

// ── File collection ──────────────────────────────────────────────

async function collectTargets(args) {
  // Returns [{ path, kind: 'entry' | 'session' }]. No args: the live session.json.
  if (!args.length) {
    return [{ path: paths.session, kind: 'session' }];
  }
  const targets = [];
  for (const arg of args) {
    const p = path.resolve(arg);
    let stat;
    try { stat = await fs.stat(p); }
    catch { targets.push({ path: p, kind: 'missing' }); continue; }
    if (stat.isDirectory()) {
      const sessionPath = path.join(p, 'session.json');
      if (await fs.pathExists(sessionPath)) targets.push({ path: sessionPath, kind: 'session' });
      const stack = [p];
      while (stack.length) {
        const dir = stack.pop();
        let entries = [];
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) stack.push(full);
          else if (e.name.endsWith('.md')) targets.push({ path: full, kind: 'entry' });
        }
      }
    } else if (p.endsWith('.json')) {
      targets.push({ path: p, kind: 'session' });
    } else {
      targets.push({ path: p, kind: 'entry' });
    }
  }
  return targets;
}

// ── Command ──────────────────────────────────────────────────────

export async function validateCommand(args = [], options = {}) {
  const targets = await collectTargets(args);

  console.log('\n' + chalk.bold.white('  memoir validate') + chalk.gray(' — format v0.1 draft (docs/SPEC.md)') + '\n');

  let checked = 0;
  let failed = 0;
  let totalWarnings = 0;

  for (const target of targets) {
    const rel = target.path.startsWith(process.cwd()) ? path.relative(process.cwd(), target.path) : target.path;

    if (target.kind === 'missing') {
      failed++;
      console.log(chalk.red('  ✖ ') + chalk.white(rel));
      console.log(chalk.red('      error    ') + 'file not found');
      continue;
    }

    checked++;
    let result;
    if (target.kind === 'session') {
      let parsed;
      try {
        parsed = JSON.parse(await fs.readFile(target.path, 'utf8'));
      } catch (err) {
        result = { errors: [`unparseable JSON: ${err.message}`], warnings: [] };
      }
      if (!result) result = validateSessionObject(parsed);
    } else {
      let raw;
      try {
        raw = await fs.readFile(target.path, 'utf8');
      } catch (err) {
        result = { errors: [`unreadable: ${err.message}`], warnings: [] };
      }
      if (!result) result = validateEntry(raw);
    }

    const { errors, warnings } = result;
    totalWarnings += warnings.length;
    const fails = errors.length > 0 || (options.strict && warnings.length > 0);
    if (fails) failed++;

    const mark = fails ? chalk.red('  ✖ ') : warnings.length ? chalk.yellow('  ⚠ ') : chalk.green('  ✔ ');
    console.log(mark + chalk.white(rel));
    for (const e of errors) console.log(chalk.red('      error    ') + e);
    for (const w of warnings) console.log(chalk.yellow('      warning  ') + w);
  }

  const parts = [`${checked} file${checked !== 1 ? 's' : ''} checked`];
  parts.push(failed > 0 ? chalk.red(`${failed} failed`) : chalk.green('all passed'));
  if (totalWarnings > 0) parts.push(chalk.yellow(`${totalWarnings} warning${totalWarnings !== 1 ? 's' : ''}`));
  console.log('\n  ' + parts.join(chalk.gray(' · ')) + '\n');

  if (failed > 0) process.exitCode = 1;
  return { checked, failed, warnings: totalWarnings };
}
