const $ = id => document.getElementById(id);
const fragment = new URLSearchParams(location.hash.slice(1));
let token = fragment.get('token');
// Restricted storage must not break the active launch link. Keep the capability
// in memory for this page even when the browser refuses session storage.
try { if (token) sessionStorage.setItem('memoir-view-token', token); else token = sessionStorage.getItem('memoir-view-token'); } catch {}
if (fragment.has('token')) history.replaceState(null, '', '/');
let state, selected = 'overview', editing, latestEdit, editorOpener, busy = false, stateRequest = 0, renderAfterEditor = false;
const labels = { overview: 'Overview', answer: 'Answers', decision: 'Decisions', check: 'Checks', next: 'Next steps', goal: 'Goals', removed: 'Removed' };
const descriptions = { overview: 'The context your next session will use.', answer: 'Questions already answered, ready for the next session.', decision: 'What was decided, and why.', check: 'What actually ran, and what needs checking again.', next: 'Completed work and the steps still ahead.', goal: 'What this project is working toward.', removed: 'Hidden from the handoff. Earlier versions stay on this computer.' };
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function button(text, action, className = '') { const node = el('button', text, className); node.type = 'button'; node.addEventListener('click', action); return node; }
function date(value) { return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }
function notice(message, error = false, undo) {
  $('notice').replaceChildren(); const node = el('div', undefined, 'notice' + (error ? ' error' : '')); node.append(el('span', message));
  if (undo) node.append(button('Undo', undo)); $('notice').append(node);
}
async function request(route, input) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    let response, result;
    try {
      response = await fetch(route, { method: input ? 'POST' : 'GET', signal: controller.signal, cache: 'no-store', headers: { Authorization: 'Bearer ' + (token || ''), ...(input ? { 'Content-Type': 'application/json' } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
      result = await response.json();
    } catch {
      const error = new Error(input ? 'The connection was interrupted. The change may already be saved. Your draft is kept; review the latest version before trying again.' : 'Could not refresh. Check that the local Memoir view is still running, then try Refresh.');
      error.code = input ? 'save_unconfirmed' : 'connection_failed'; throw error;
    }
    if (!response.ok) { const error = new Error(result.error || 'Could not save. Refresh and try again.'); error.code = result.code; throw error; } return result;
  } finally { clearTimeout(timeout); }
}
async function refresh() {
  if (busy || $('editor').open) return;
  const generation = ++stateRequest;
  try {
    const result = await request('/api/state');
    if (generation !== stateRequest || busy || $('editor').open) return;
    state = result; render();
  } catch (error) { if (generation === stateRequest) notice(error.message, true); }
}
function nav() {
  $('navigation').replaceChildren();
  for (const [key, label] of Object.entries(labels)) {
    const count = key === 'overview' ? null : key === 'removed' ? state.removed.length : key === 'check' ? state.checks.length : state.records.filter(r => r.kind === key).length;
    const node = button(label, () => { selected = key; $('search').value = ''; render(); $('section-title').focus(); });
    if (selected === key) node.setAttribute('aria-current', 'page');
    if (count !== null) node.append(el('span', count, 'count')); $('navigation').append(node);
  }
}
function metadata(item, check = false) {
  const details = el('details', undefined, 'metadata'); details.append(el('summary', check ? 'Evidence and covered files' : 'Source and earlier versions'));
  details.append(el('p', `Saved ${date(item.recorded_at)} · revision ${item.revision}`));
  if (check) {
    details.append(el('p', `Exit status: ${item.exit_code ?? 'unavailable'}. Local receipt; not authenticated.`));
    const list = el('ul'); Object.keys(item.inputs).forEach(file => list.append(el('li', file))); details.append(list);
    details.append(el('p', 'Output was discarded. Its fingerprint:')); details.append(el('code', item.output_sha256));
  } else {
    details.append(el('p', item.source)); if (item.why) details.append(el('p', 'Why: ' + item.why));
    const history = state.history.filter(r => r.id === item.id && r.revision < item.revision).reverse();
    for (const old of history) { const row = el('p', `Revision ${old.revision} · ${date(old.recorded_at)}\n${old.text}${old.answer ? '\n' + old.answer : ''}\nSource: ${old.source}`); details.append(row); }
    if (!history.length) details.append(el('p', 'No earlier versions.'));
  }
  return details;
}
function recordCard(item, removed = false) {
  const card = el('article', undefined, 'card' + (item.kind === 'next' && item.status === 'done' ? ' done' : ''));
  card.dataset.recordId = item.id;
  const kind = item.kind === 'next' ? (item.status === 'done' ? 'DONE' : 'TO DO') : item.kind === 'answer' ? 'ANSWERED' : item.kind.toUpperCase();
  card.append(el('span', removed ? 'REMOVED' : kind, 'badge' + (removed ? ' neutral' : '')));
  card.append(el('h3', item.text)); if (item.answer) card.append(el('p', item.answer, 'answer'));
  if (item.why && !removed) card.append(el('p', item.why, 'hidden-note'));
  const actions = el('div', undefined, 'card-actions');
  if (removed) actions.append(button('Restore to handoff', () => restore(item)));
  else {
    actions.append(button('Correct', () => edit(item)));
    if (item.kind === 'next') actions.append(button(item.status === 'done' ? 'Reopen' : 'Mark done', () => changeStatus(item)));
    actions.append(button('Remove from handoff', () => remove(item), 'remove'));
  }
  card.append(actions, metadata(item)); return card;
}
function checkCard(item, removed = false) {
  const matched = item.freshness === 'inputs-match';
  const card = el('article', undefined, 'card');
  card.append(el('span', removed ? 'REMOVED RECEIPT' : matched ? 'PASSED · FILES MATCH' : 'NEEDS RECHECK', 'badge' + (removed ? ' neutral' : matched ? '' : ' warn')));
  card.append(el('h3', item.title));
  if (!removed && item.reasons.length) { const reasons = el('ul', undefined, 'reasons'); item.reasons.forEach(reason => reasons.append(el('li', reason))); card.append(reasons); }
  if (!removed) card.append(el('p', matched ? 'This result still covers the listed files. External settings need their own verification.' : 'Tell the next agent to review these changes before relying on the old result.', 'hidden-note'));
  else card.append(el('p', 'Run a new authorized check to replace this receipt.', 'hidden-note'));
  card.append(metadata(item, true)); if (!removed) { const actions = el('div', undefined, 'card-actions'); actions.append(button('Remove from handoff', () => remove(item, 'check'), 'remove')); card.append(actions); }
  return card;
}
function matches(item) { const query = $('search').value.toLowerCase().trim(); return !query || [item.text, item.answer, item.why, item.title, item.id].filter(Boolean).join(' ').toLowerCase().includes(query); }
function group(kind, items, limit = Infinity) {
  const section = el('section', undefined, 'group'); const heading = el('div', undefined, 'group-title'); heading.append(el('h3', labels[kind]));
  if (selected === 'overview') heading.append(button('View all →', () => { selected = kind; render(); $('section-title').focus(); })); section.append(heading);
  const cards = el('div', undefined, 'cards'); items.filter(matches).slice(0, limit).forEach(item => cards.append(kind === 'check' ? checkCard(item) : recordCard(item))); section.append(cards); return section;
}
function render() {
  if (!state) return;
  renderAfterEditor = false; $('add').disabled = busy;
  nav(); $('project').textContent = `${state.project_name} / ${state.branch || 'No Git branch'}`;
  $('revision').textContent = `Handoff revision ${state.revision}. Refreshed ${new Date().toLocaleTimeString()}.`;
  $('section-title').textContent = labels[selected]; $('section-description').textContent = descriptions[selected];
  $('goal').replaceChildren();
  if (selected === 'overview') { const goal = state.records.filter(r => r.kind === 'goal').sort((a,b) => b.revision - a.revision)[0]; if (goal) { const node = el('div', undefined, 'goal'); node.append(el('p', 'CURRENT GOAL', 'eyebrow'), el('p', goal.text), button('Edit goal', () => edit(goal), 'quiet')); $('goal').append(node); } }
  const content = $('content'); content.replaceChildren();
  if (selected === 'removed') {
    const cards = el('div', undefined, 'cards'); state.removed.filter(r => matches(r.item)).forEach(r => cards.append(r.category === 'check' ? checkCard(r.item, true) : recordCard(r.item, true))); content.append(cards);
  } else if (selected === 'overview') {
    for (const kind of ['next','answer','check','decision']) {
      let items = [...(kind === 'check' ? state.checks : state.records.filter(r => r.kind === kind))].sort((a,b) => b.revision - a.revision);
      if (kind === 'next') items = [...items].sort((a,b) => (a.status === 'done') - (b.status === 'done') || b.revision - a.revision);
      if (items.some(matches)) content.append(group(kind, items, 2));
    }
  } else content.append(group(selected, selected === 'check' ? state.checks : state.records.filter(r => r.kind === selected)));
  if (!content.querySelector('.card')) { const empty = el('div', undefined, 'empty'); empty.append(el('strong', $('search').value ? 'No matching memories' : selected === 'removed' ? 'Nothing removed' : 'A fresh start'), el('span', $('search').value ? 'Try a shorter search.' : selected === 'removed' ? 'Items you remove will appear here.' : 'Add an answer, a decision or the next step.')); content.replaceChildren(empty); }
}
function kindFields() {
  $('answer-label').hidden = $('kind').value !== 'answer'; $('answer').required = $('kind').value === 'answer';
  $('status-label').hidden = $('kind').value !== 'next'; $('text-label').textContent = $('kind').value === 'answer' ? 'Question' : $('kind').value === 'next' ? 'Next step' : $('kind').value === 'goal' ? 'Goal' : 'Decision';
}
function edit(item) {
  if (!state || busy) return;
  ++stateRequest;
  editorOpener = document.activeElement; latestEdit = null;
  // Reuse a new record's ID after an uncertain response. A retry must conflict
  // with a committed save instead of creating a second copy of the same draft.
  editing = { item, id: item?.id || 'record.' + crypto.randomUUID(), branch: state.branch };
  $('review-latest').hidden = true; $('comparison').hidden = true;
  $('editor-title').textContent = item ? 'Correct memory' : 'Add memory'; $('save').textContent = item ? 'Save correction' : 'Save memory';
  $('kind').value = item?.kind || 'answer'; $('kind').disabled = !!item;
  $('text').value = item?.text || ''; $('answer').value = item?.answer || ''; $('why').value = item?.why || ''; $('status').value = item?.status || 'open';
  $('form-error').textContent = ''; kindFields(); $('editor').showModal(); $('text').focus();
}
async function action(input) {
  if (busy) throw new Error('A change is already being saved.'); busy = true; ++stateRequest;
  $('add').disabled = true; $('refresh').disabled = true;
  try { state = await request('/api/action', input); render(); }
  finally { busy = false; $('add').disabled = !state; $('refresh').disabled = false; }
}
async function remove(item, category = 'record') {
  const branch = state.branch;
  try { await action({ action:'remove', branch, id:item.id, category, expected_revision:item.revision }); notice('Removed from the handoff. Earlier versions are kept locally.', false, category === 'record' ? () => restore(item, branch) : undefined); }
  catch (error) { notice(error.message, true); }
}
async function restore(item, branch = state.branch) {
  try { await action({ action:'restore', branch, id:item.id, expected_revision:item.revision }); notice('Restored to the handoff.'); }
  catch (error) { notice(error.message, true); }
}
function fields(item) { return { kind:item.kind, text:item.text, ...(item.answer ? {answer:item.answer} : {}), ...(item.why ? {why:item.why} : {}), status:item.status }; }
async function changeStatus(item) {
  try { await action({ action:'save', branch:state.branch, id:item.id, expected_revision:item.revision, fields:{...fields(item),status:item.status === 'done' ? 'open' : 'done'} }); notice(item.status === 'done' ? 'Step reopened.' : 'Step marked done.'); }
  catch (error) { notice(error.message, true); }
}
function editorSaving(saving) {
  for (const id of ['text', 'answer', 'why', 'status', 'save', 'cancel', 'cancel-top', 'review-latest', 'keep-draft']) $(id).disabled = saving;
  $('kind').disabled = saving || !!editing?.item;
}
$('edit-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!editing || busy) return;
  const submitted = editing;
  submitted.saving = true; editorSaving(true); $('form-error').textContent = '';
  try {
    const kind = $('kind').value;
    await action({ action:'save', branch:submitted.branch, id:submitted.id, expected_revision:submitted.item?.revision || 0, fields:{kind,text:$('text').value, ...(kind === 'answer' ? {answer:$('answer').value} : {}), ...($('why').value ? {why:$('why').value} : {}),status:kind === 'next' ? $('status').value : 'open'} });
    if (editing === submitted) $('editor').close();
    notice(submitted.item ? 'Correction saved. The next session will use this version.' : 'Memory saved for the next session.');
  } catch (error) { if (editing === submitted) { $('form-error').textContent = error.message; $('review-latest').hidden = !['refresh_required', 'save_unconfirmed'].includes(error.code); } }
  finally { submitted.saving = false; if (editing === submitted || !editing) editorSaving(false); }
});
$('review-latest').addEventListener('click', async () => {
  if (!editing || busy) return;
  const reviewed = editing, generation = ++stateRequest;
  try {
    const latest = await request('/api/state');
    if (editing !== reviewed || generation !== stateRequest) return;
    if (latest.branch !== reviewed.branch) throw new Error('The project is on a different branch. Copy any draft you need, then close this editor and refresh to review that branch.');
    state = latest; renderAfterEditor = true;
    const item = latest.records.find(record => record.id === reviewed.id);
    if (!item) throw new Error(reviewed.item || latest.removed.some(record => record.item.id === reviewed.id) ? 'This item was removed. Your draft is still here. Close the editor and refresh, then use Removed to review or restore it.' : 'This new memory is not in the saved handoff yet. Your draft is kept. Try Save memory again.');
    latestEdit = { item, id:item.id, branch: latest.branch };
    $('latest-text').textContent = item.text + (item.answer ? '\n\n' + item.answer : '') + (item.why ? '\n\nWhy: ' + item.why : '') + (item.kind === 'next' ? '\nProgress: ' + item.status : '');
    $('comparison').hidden = false; $('keep-draft').focus();
  } catch (error) { if (editing === reviewed && generation === stateRequest) $('form-error').textContent = error.message; }
});
$('keep-draft').addEventListener('click', () => {
  if (!latestEdit) return;
  editing = latestEdit; latestEdit = null; $('comparison').hidden = true; $('review-latest').hidden = true;
  $('kind').value = editing.item.kind; $('kind').disabled = true; kindFields();
  $('save').textContent = 'Save correction';
  $('form-error').textContent = 'Latest version reviewed. Save correction when your draft is ready.'; $('text').focus();
});
$('editor').addEventListener('close', () => {
  ++stateRequest;
  if (renderAfterEditor) render();
  const card = [...document.querySelectorAll('[data-record-id]')].find(node => node.dataset.recordId === editing?.item?.id);
  (editorOpener?.isConnected ? editorOpener : card?.querySelector('button') || (editing?.item?.kind === 'goal' && $('goal').querySelector('button')) || $('add')).focus();
  editing = null; latestEdit = null;
});
$('editor').addEventListener('cancel', event => { if (editing?.saving) event.preventDefault(); });
$('kind').addEventListener('change', kindFields); $('cancel').addEventListener('click', () => $('editor').close()); $('cancel-top').addEventListener('click', () => $('editor').close());
$('add').addEventListener('click', () => edit()); $('refresh').addEventListener('click', refresh); $('search').addEventListener('input', render);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('editor').open && !busy) refresh(); });
refresh();
