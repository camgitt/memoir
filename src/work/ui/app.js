const $ = id => document.getElementById(id);
const fragment = new URLSearchParams(location.hash.slice(1));
let token = fragment.get('token');
// Restricted storage must not break the active launch link. Keep the capability
// in memory for this page even when the browser refuses session storage.
try { if (token) sessionStorage.setItem('memoir-view-token', token); else token = sessionStorage.getItem('memoir-view-token'); } catch {}
if (fragment.has('token')) history.replaceState(null, '', '/');
let state, selected = 'overview', editing, latestEdit, editorOpener, busy = false, stateRequest = 0, renderAfterEditor = false;
let viewMode = 'records', focusKey = 'project', showSuggestions = false;
const labels = { overview: 'Overview', next: 'Next actions', answer: 'Answers', decision: 'Decisions', check: 'Checks', goal: 'Goals', removed: 'Removed' };
const descriptions = { overview: 'What matters for your next session.', answer: 'Already answered. Ready to carry forward.', decision: 'What you decided, with the reasons behind it.', check: 'Completed checks and the changes that need another look.', next: 'Open work first. Completed actions stay in the record.', goal: 'What this project is working toward.', removed: 'Hidden from the handoff. You can restore records here.' };
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function button(text, action, className = '') { const node = el('button', text, className); node.type = 'button'; node.addEventListener('click', action); return node; }
function date(value) { return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }
function searchableText(item) { return [item.text,item.answer,item.title,item.why,item.source,item.id,...Object.keys(item.inputs||{})].filter(Boolean).join(' ').toLowerCase(); }
function entryLabel(item) {
  const text = item.kind === 'next' || /^record\.[0-9a-f-]{36}$/i.test(item.id) ? item.text.split(/(?<=[.!?])\s/)[0] : item.id.replace(/^(?:record|decision|answer|check|next|goal)\./, '').replace(/[._-]+/g, ' ').replace(/^./, c => c.toUpperCase()).replace(/\bcli\b/ig, 'CLI');
  return text.length > 62 ? text.slice(0,59).trimEnd() + '…' : text;
}
// A bounded, local projection of existing records. Shared words are suggestions,
// never saved relationships, causal claims, or proof that a decision is correct.
function buildProjectMap(data, { query = '', focus = 'project', kind = 'all' } = {}) {
  const body = item => [item.text, item.answer, item.title, item.why, item.source].filter(Boolean).join(' ');
  const label = entryLabel;
  const all = [...data.records.map(item => ({key:'record:'+item.id,kind:item.kind,item,label:label(item)})), ...data.checks.map(item => ({key:'check:'+item.id,kind:'check',item,label:label(item)}))].sort((a,b) => b.item.revision-a.item.revision);
  const search = query.toLowerCase().trim();
  const matches = node => (kind==='all'||node.kind===kind) && (!search || searchableText(node.item).includes(search));
  const ordered = [...all].sort((a,b) => (b.key===focus)-(a.key===focus) || Number(matches(b))-Number(matches(a)));
  const nodes = ordered.slice(0,120), edges = [];
  for (const node of nodes) edges.push({source:'project',target:node.key,type:'recorded',label:'Stored in this project on the current branch.'});
  const stop = new Set('about after again also already another before being branch checks completed context current decisions during existing files first found from have into local memoir memory needs next only passed personal project record records release review saved session should source state test tests that their these they this through using verified version were what when which will with work workflow would'.split(' '));
  const terms = new Map(nodes.map(node => [node.key,new Set((body(node.item).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)||[]).filter(word => word.length>=4 && /\p{L}/u.test(word) && !stop.has(word)).slice(0,180))]));
  const frequency = new Map(); for (const set of terms.values()) for (const term of set) frequency.set(term,(frequency.get(term)||0)+1);
  const references=new Map(nodes.map(node=>[node.key,new Set((body(node.item).match(/[A-Za-z0-9][A-Za-z0-9._/-]*/g)||[]).map(token=>token.replace(/\.+$/,'')))]));
  for (let i=0;i<nodes.length;i++) for (let j=i+1;j<nodes.length;j++) {
    const a=nodes[i], b=nodes[j];
    const reference = references.get(a.key).has(b.item.id) ? [a,b] : references.get(b.key).has(a.item.id) ? [b,a] : null;
    if (reference) { edges.push({source:a.key,target:b.key,type:'recorded',label:reference[0].label+' explicitly mentions '+reference[1].item.id+'.'}); continue; }
    const receipt = a.kind==='check'?a:b.kind==='check'?b:null, note=receipt===a?b:a;
    const paths = receipt && note.kind!=='check' ? Object.keys(receipt.item.inputs||{}).filter(file=>references.get(note.key).has(file)) : [];
    if (paths.length) { edges.push({source:a.key,target:b.key,type:'recorded',label:'This entry names '+paths.slice(0,3).join(', ')+'. The check declares '+(paths.length===1?'that file':'those files')+' as input; this does not verify the entry’s claims.'}); continue; }
    const shared=[...terms.get(a.key)].filter(word=>terms.get(b.key).has(word) && frequency.get(word)<=Math.max(3,nodes.length*.6));
    if (shared.length>=3) {
      shared.sort((x,y)=>frequency.get(x)-frequency.get(y)||x.localeCompare(y));
      edges.push({source:a.key,target:b.key,type:'suggested',score:shared.reduce((sum,word)=>sum+1/frequency.get(word),0),label:'Suggested from shared words: '+shared.slice(0,5).join(', ')+'. This is not a saved relationship.'});
    }
  }
  return {nodes,edges,total:all.length,matches:nodes.filter(matches),matchingTotal:all.filter(matches).length};
}
function mapNeighborhood(model, focus, suggestions = false, overview = false) {
  const linked = focus ? model.edges.filter(edge => edge.source !== 'project' && edge.target !== 'project' &&
    (edge.source === focus.key || edge.target === focus.key) && (suggestions || edge.type === 'recorded'))
    .sort((a,b) => (a.type === 'suggested') - (b.type === 'suggested') || (b.score || 0) - (a.score || 0)) : [];
  let ranked = focus ? linked.map(edge => model.nodes.find(node => node.key === (edge.source === focus.key ? edge.target : edge.source))) : [...model.matches];
  if (!focus && overview) {
    const picked = [];
    for (const kind of ['goal','next','answer','decision','check']) {
      const entry = ranked.find(node => node.kind === kind && (kind !== 'next' || node.item.status !== 'done'));
      if (entry) picked.push(entry);
    }
    ranked = [...picked,...ranked.filter(node => !picked.includes(node))];
  }
  const shown = ranked.slice(0,6), visibleKeys = new Set(shown.map(node => node.key));
  const edges = focus ? linked.filter(edge => visibleKeys.has(edge.source) || visibleKeys.has(edge.target)) :
    model.edges.filter(edge => edge.source === 'project' && visibleKeys.has(edge.target));
  return {ranked,shown,edges,linked};
}
function selectMapNode(key) {
  focusKey=key; renderMap(true);
}
function renderMap(restoreFocus = false) {
  if (!state) return;
  const mapKind = selected === 'overview' || selected === 'removed' ? 'all' : selected;
  const model=buildProjectMap(state,{query:$('search').value,focus:focusKey,kind:mapKind});
  if (focusKey!=='project'&&!model.nodes.some(node=>node.key===focusKey)) focusKey='project';
  const focus=model.nodes.find(node=>node.key===focusKey);
  $('map-workspace').dataset.focused=String(!!focus);
  const {ranked,shown,edges,linked}=mapNeighborhood(model,focus,showSuggestions,!$('search').value.trim()&&mapKind==='all');
  $('map-count').textContent=focus ? shown.length+' of '+ranked.length+' connections · '+focus.label :
    shown.length+' of '+model.matchingTotal+' entries'+(model.total>120?' · search to find older entries':'');
  $('map-suggestions').setAttribute('aria-pressed',String(showSuggestions));
  $('map-suggested-legend').hidden=!showSuggestions;
  const canvas=$('map-canvas');canvas.replaceChildren();
  const positions=[[22,18],[78,18],[19,47],[81,47],[22,77],[78,77]];
  const center=focus||{key:'project',kind:'project',label:state.project_name};
  const points=new Map([[center.key,[50,47]],...shown.map((node,index)=>[node.key,positions[index]])]);
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 1000 640');svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('aria-hidden','true');svg.setAttribute('class','map-lines');
  for(const edge of edges) {
    const a=points.get(edge.source),b=points.get(edge.target),line=document.createElementNS('http://www.w3.org/2000/svg','path');
    line.setAttribute('d',`M ${a[0]*10} ${a[1]*6.4} L ${b[0]*10} ${b[1]*6.4}`);
    line.setAttribute('class','map-line '+edge.type+((edge.source===focusKey||edge.target===focusKey)&&focusKey!=='project'?' focused':''));svg.append(line);
  }
  canvas.append(svg);
  let focusedButton;
  for(const node of [center,...shown]) {
    const active=node.key===focusKey;
    const entry=button('',()=>selectMapNode(node.key),'map-node'+(active?' selected':''));
    entry.dataset.center=String(node.key===center.key);
    entry.dataset.kind=node.kind;entry.dataset.nodeKey=node.key;entry.style.left=points.get(node.key)[0]+'%';entry.style.top=points.get(node.key)[1]+'%';entry.setAttribute('aria-pressed',String(active));entry.setAttribute('aria-label',(node.kind==='project'?'Project':labels[node.kind])+': '+(node.item?.text||node.item?.title||node.label));
    const dot=el('span',undefined,'node-dot');dot.setAttribute('aria-hidden','true');
    entry.append(dot,el('span',node.label,'node-label'),el('span',node.kind==='project'?model.total+' entries':node.kind==='check'?(node.item.freshness==='inputs-match'?'Inputs match':'Needs review'):node.kind==='next'?(node.item.status==='done'?'Completed':'Next action'):labels[node.kind],'node-kind'));
    canvas.append(entry);if(active)focusedButton=entry;
  }
  if(!shown.length)canvas.append(el('p',focus?(showSuggestions?'No connected entries found.':'No recorded connections yet. Try Suggested links.'):$('search').value?'No matching entries. Try another term.':'No entries in this category yet.','map-empty'));
  const panel=$('map-inspector');panel.replaceChildren();
  if(focus)panel.append(button('← Back to project',()=>{focusKey='project';renderMap(true);},'inspector-back'));
  const panelTitle=el('h2',focus?focus.label:state.project_name);panelTitle.tabIndex=-1;
  panel.append(el('p',focus?'IN FOCUS':'PROJECT BRIEF','inspector-eyebrow'),panelTitle);
  if(focus) {
    const card=focus.kind==='check'?checkCard(focus.item):recordCard(focus.item);card.className+=' expanded';panel.append(card);
    panel.append(button('Open in Records ↗', () => { selected = focus.kind; $('search').value = ''; setView('records'); $('section-title').focus(); }, 'inspector-back'));
    const connections=el('div',undefined,'inspector-connections');connections.append(el('h3','Connected context'));
    const relevant=linked.slice(0,6);
    if(!relevant.length)connections.append(el('p',showSuggestions?'No recorded references or shared topics found.':'No recorded references found. Suggested links can reveal possible shared topics.','connection-note'));
    for(const edge of relevant) {
      const other=model.nodes.find(node=>node.key===(edge.source===focusKey?edge.target:edge.source));
      const row=button('',()=>selectMapNode(other.key),'connection-row');
      row.append(el('span',edge.type==='recorded'?'RECORDED LINK':'SUGGESTED LINK','connection-type '+edge.type),el('strong',other.label),el('span',edge.label,'connection-reason'));connections.append(row);
    }
    if(linked.length>6)connections.append(el('p','Showing 6 of '+linked.length+' connections. Search for another entry to explore more.','connection-note'));
    panel.append(connections);
  } else {
    const goal=state.records.filter(item=>item.kind==='goal').sort((a,b)=>b.revision-a.revision)[0];
    panel.append(el('p',goal?.text||'Start with an answer, a decision or a next action. Connections appear as your project record grows.','project-brief'));
    panel.append(el('p','Select an entry to read the full context and see why it is connected.','inspector-hint'));
    panel.append(button('+ Add project context',()=>edit(), 'map-add'));
    const index=el('div',undefined,'inspector-index');index.append(el('h3',$('search').value?'Search results':mapKind==='all'?'Project entries':labels[mapKind]));
    for(const node of ranked.slice(0,24)) {const row=button('',()=>selectMapNode(node.key),'index-entry');row.dataset.kind=node.kind;row.setAttribute('aria-label',labels[node.kind]+': '+node.label);row.append(el('i'),el('span',node.label),el('span','↗'));index.append(row);}
    if(ranked.length>24)index.append(el('p','Search to narrow '+ranked.length+' matching entries.','connection-note'));
    panel.append(index);
  }
  panel.scrollTop=0;
  // In narrow windows the detail panel follows the map in normal flow. Move
  // focus to its heading so the selected context is visible without an overlay.
  if(restoreFocus)(focus?panelTitle:focusedButton)?.focus();
}
function setView(mode) {
  viewMode=mode;
  if (mode === 'map' && selected === 'removed') { selected = 'overview'; focusKey = 'project'; }
  $('map-workspace').hidden=mode!=='map';$('records-workspace').hidden=mode!=='records';
  $('show-map').setAttribute('aria-pressed',String(mode==='map'));$('show-records').setAttribute('aria-pressed',String(mode==='records'));
  render();
}
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
    const node = button('', () => { selected = key; focusKey = 'project'; if (key === 'removed') setView('records'); else render(); [...$('navigation').children].find(entry => entry.dataset.kind === key)?.focus({preventScroll:true}); });
    node.dataset.kind = key;
    const icon = el('span', undefined, 'nav-icon icon-' + key); icon.setAttribute('aria-hidden', 'true'); node.append(icon, el('span', label, 'nav-name'));
    if (selected === key) node.setAttribute('aria-current', 'page');
    if (count !== null) node.append(el('span', count, 'count')); $('navigation').append(node);
  }
}
function summary() {
  const stale = state.checks.filter(r => r.freshness !== 'inputs-match').length;
  const entries = [
    ['next', state.records.filter(r => r.kind === 'next' && r.status !== 'done').length, 'Open actions'],
    ['answer', state.records.filter(r => r.kind === 'answer').length, 'Answers saved'],
    ['check', stale || state.checks.length, stale ? 'Checks to review' : 'Checks match files'],
  ];
  $('summary').replaceChildren();
  for (const [kind, count, label] of entries) {
    const node = button('', () => { selected = kind; focusKey = 'project'; $('search').value = ''; render(); $('section-title').focus(); }, 'summary-item' + (kind === 'check' && stale ? ' needs-attention' : ''));
    const arrow = el('span', '↗', 'summary-arrow'); arrow.setAttribute('aria-hidden', 'true');
    node.append(el('strong', count), el('span', label), arrow); $('summary').append(node);
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
    details.append(el('p', item.source)); if (item.why && item.kind !== 'next') details.append(el('p', 'Why: ' + item.why));
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
  const heading = el('div', undefined, 'card-heading'); heading.append(el('span', removed ? 'REMOVED' : kind, 'badge' + (removed ? ' neutral' : '')), el('span', new Date(item.recorded_at).toLocaleDateString([], { month:'short', day:'numeric' }), 'record-date')); card.append(heading);
  const copy = el('div', undefined, 'record-copy');
  copy.append(el('h3', item.kind === 'answer' ? item.text : entryLabel(item)));
  if (item.kind !== 'answer') copy.append(el('p', item.text, 'record-text'));
  if (item.kind === 'next' && item.why) copy.append(el('p', item.why, 'record-text'));
  if (item.answer) copy.append(el('p', item.answer, 'answer')); card.append(copy);
  const compact = selected === 'overview' && !$('search').value.trim() && viewMode === 'records';
  if (compact || item.text.length > 200 || item.answer?.length > 220 || item.kind === 'next' && item.why?.length > 220) {
    card.className += ' has-preview';
    let expanded = focusKey === 'record:' + item.id;
    if (expanded) card.className += ' expanded';
    const collapsedLabel = compact ? 'Details' : 'Read full entry';
    const more = button(collapsedLabel, () => { expanded = !expanded; card.className = card.className.replace(' expanded', '') + (expanded ? ' expanded' : ''); more.textContent = expanded ? 'Show less' : collapsedLabel; more.setAttribute('aria-expanded', String(expanded)); }, 'read-more');
    more.textContent = expanded ? 'Show less' : collapsedLabel;
    more.setAttribute('aria-expanded', String(expanded)); card.append(more);
  }
  const actions = el('div', undefined, 'card-actions');
  if (removed) actions.append(button('Restore to handoff', () => restore(item)));
  else {
    actions.append(button('Correct', () => edit(item)));
    if (item.kind === 'next') actions.append(button(item.status === 'done' ? 'Reopen' : 'Mark done', () => changeStatus(item)));
    if (viewMode === 'records') actions.append(button('Connections', () => { focusKey = 'record:' + item.id; setView('map'); renderMap(true); }));
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
function matches(item) { const query = $('search').value.toLowerCase().trim(); return !query || searchableText(item).includes(query); }
function group(kind, items, limit = Infinity) {
  const section = el('section', undefined, 'group'); const heading = el('div', undefined, 'group-title'); heading.append(el('h3', labels[kind]));
  if (selected === 'overview') heading.append(button('View all →', () => { selected = kind; render(); $('section-title').focus(); }));
  if (selected === 'overview') section.append(heading);
  const cards = el('div', undefined, 'cards'); items.filter(matches).slice(0, limit).forEach(item => cards.append(kind === 'check' ? checkCard(item) : recordCard(item))); section.append(cards);
  if (selected === 'overview' && !$('search').value.trim() && ['answer','decision'].includes(kind)) {
    const archive = el('details', undefined, 'archive-group');
    archive.append(el('summary', (kind === 'answer' ? 'Saved answers' : 'Recent decisions') + ' · ' + items.length), section);
    return archive;
  }
  return section;
}
function render() {
  if (!state) return;
  renderAfterEditor = false; $('add').disabled = busy;
  nav(); summary(); $('project').replaceChildren(el('span', state.project_name, 'project-name'), el('span', state.branch || 'No Git branch', 'branch-name'));
  $('revision').textContent = `Handoff revision ${state.revision}. Refreshed ${new Date().toLocaleTimeString()}.`;
  $('section-title').textContent = labels[selected]; $('section-description').textContent = descriptions[selected];
  $('goal').replaceChildren();
  $('view-caption').textContent = viewMode === 'map' ? 'Connections' : 'Saved context';
  $('summary').hidden = selected !== 'overview' || viewMode === 'map';
  if (selected === 'overview' && viewMode === 'records') {
    const goal = state.records.filter(r => r.kind === 'goal').sort((a,b) => b.revision - a.revision)[0];
    if (goal) {
      const node = el('details', undefined, 'goal');
      node.append(el('summary', 'Current focus'), el('p', goal.text), button('Edit goal', () => edit(goal), 'quiet')); $('goal').append(node);
    }
  }
  const content = $('content'); content.replaceChildren();
  content.dataset.compact = String(selected === 'overview' && !$('search').value.trim());
  if (selected === 'removed') {
    const cards = el('div', undefined, 'cards'); state.removed.filter(r => matches(r.item)).forEach(r => cards.append(r.category === 'check' ? checkCard(r.item, true) : recordCard(r.item, true))); content.append(cards);
  } else if (selected === 'overview') {
    for (const kind of ['next','answer','check','decision','goal']) {
      let items = [...(kind === 'check' ? state.checks : state.records.filter(r => r.kind === kind))].sort((a,b) => b.revision - a.revision);
      if (kind === 'goal' && !$('search').value.trim()) continue;
      if (kind === 'next' && !$('search').value.trim()) items = items.filter(item => item.status !== 'done');
      if (kind === 'check' && !$('search').value.trim()) items = items.filter(item => item.freshness !== 'inputs-match');
      if (kind === 'check') items.sort((a,b) => (a.freshness === 'inputs-match') - (b.freshness === 'inputs-match') || b.revision - a.revision);
      if (items.some(matches)) content.append(group(kind, items, $('search').value.trim() || kind === 'next' || kind === 'check' ? Infinity : 2));
    }
  } else {
    const items = [...(selected === 'check' ? state.checks : state.records.filter(r => r.kind === selected))].sort((a,b) => b.revision - a.revision);
    if (selected === 'next') items.sort((a,b) => (a.status === 'done') - (b.status === 'done') || b.revision - a.revision);
    if (selected === 'check') items.sort((a,b) => (a.freshness === 'inputs-match') - (b.freshness === 'inputs-match') || b.revision - a.revision);
    if (focusKey !== 'project') items.sort((a,b) => Number(focusKey.endsWith(':' + b.id)) - Number(focusKey.endsWith(':' + a.id)));
    content.append(group(selected, items));
  }
  if (!content.querySelector('.card')) { const empty = el('div', undefined, 'empty'); empty.append(el('strong', $('search').value ? 'No matching memories' : selected === 'removed' ? 'Nothing removed' : 'A fresh start'), el('span', $('search').value ? 'Try a shorter search.' : selected === 'removed' ? 'Items you remove will appear here.' : 'Add an answer, a decision or the next step.')); content.replaceChildren(empty); }
  renderMap();
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
  editing = { item, id: item?.id || 'record.' + crypto.randomUUID(), branch: state.branch, expected_recovery: state.recovery_id };
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
  const branch = state.branch, recovery = state.recovery_id;
  try { await action({ action:'remove', branch, expected_recovery: recovery, id:item.id, category, expected_revision:item.revision }); notice('Removed from the handoff. Earlier versions are kept locally.', false, category === 'record' ? () => restore(item, branch, recovery) : undefined); }
  catch (error) { notice(error.message, true); }
}
async function restore(item, branch = state.branch, recovery = state.recovery_id) {
  try { await action({ action:'restore', branch, expected_recovery: recovery, id:item.id, expected_revision:item.revision }); notice('Restored to the handoff.'); }
  catch (error) { notice(error.message, true); }
}
function fields(item) { return { kind:item.kind, text:item.text, ...(item.answer ? {answer:item.answer} : {}), ...(item.why ? {why:item.why} : {}), status:item.status }; }
async function changeStatus(item) {
  try { await action({ action:'save', branch:state.branch, expected_recovery: state.recovery_id, id:item.id, expected_revision:item.revision, fields:{...fields(item),status:item.status === 'done' ? 'open' : 'done'} }); notice(item.status === 'done' ? 'Step reopened.' : 'Step marked done.'); }
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
    await action({ action:'save', branch:submitted.branch, expected_recovery: submitted.expected_recovery, id:submitted.id, expected_revision:submitted.item?.revision || 0, fields:{kind,text:$('text').value, ...(kind === 'answer' ? {answer:$('answer').value} : {}), ...($('why').value ? {why:$('why').value} : {}),status:kind === 'next' ? $('status').value : 'open'} });
    // A successful save must be visible even if the old search or category
    // would exclude it. Both views continue from the same saved entry.
    focusKey = 'record:' + submitted.id; selected = kind; $('search').value = ''; render();
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
    latestEdit = { item, id:item.id, branch: latest.branch, expected_recovery: latest.recovery_id };
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
  const activeWorkspace = $(viewMode === 'map' ? 'map-inspector' : 'content');
  const card = [...activeWorkspace.querySelectorAll('[data-record-id]')].find(node => node.dataset.recordId === editing?.id);
  (editorOpener?.isConnected ? editorOpener : card?.querySelector('.card-actions button') || (editing?.item?.kind === 'goal' && $('goal').querySelector('button')) || $('add')).focus();
  editing = null; latestEdit = null;
});
$('editor').addEventListener('cancel', event => { if (editing?.saving) event.preventDefault(); });
$('kind').addEventListener('change', kindFields); $('cancel').addEventListener('click', () => $('editor').close()); $('cancel-top').addEventListener('click', () => $('editor').close());
$('add').addEventListener('click', () => edit()); $('refresh').addEventListener('click', refresh); $('search').addEventListener('input', () => { focusKey = 'project'; render(); });
$('show-map').addEventListener('click',()=>setView('map'));$('show-records').addEventListener('click',()=>setView('records'));
$('map-suggestions').addEventListener('click',()=>{showSuggestions=!showSuggestions;renderMap();});
$('map-reset').addEventListener('click',()=>{focusKey='project';selected='overview';$('search').value='';render();});
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('editor').open && !busy) refresh(); });
refresh();
