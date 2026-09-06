const $ = id => document.getElementById(id);
const fragment = new URLSearchParams(location.hash.slice(1));
let token = fragment.get('token');
// Restricted storage must not break the active launch link. Keep the capability
// in memory for this page even when the browser refuses session storage.
try { if (token) sessionStorage.setItem('memoir-view-token', token); else token = sessionStorage.getItem('memoir-view-token'); } catch {}
if (fragment.has('token')) history.replaceState(null, '', '/');
let state, selected = 'overview', editing, latestEdit, editorOpener, busy = false, stateRequest = 0, renderAfterEditor = false;
let viewMode = 'map', focusKey = 'project', mapKind = 'all';
const labels = { overview: 'Overview', next: 'Next actions', answer: 'Answers', decision: 'Decisions', check: 'Checks', goal: 'Goals', removed: 'Removed' };
const descriptions = { overview: 'What matters for your next session.', answer: 'Already answered. Ready to carry forward.', decision: 'What you decided, with the reasons behind it.', check: 'Completed checks and the changes that need another look.', next: 'Open work first. Completed actions stay in the record.', goal: 'What this project is working toward.', removed: 'Hidden from the handoff. You can restore records here.' };
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function button(text, action, className = '') { const node = el('button', text, className); node.type = 'button'; node.addEventListener('click', action); return node; }
function date(value) { return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }
function searchableText(item) { return [item.text,item.answer,item.title,item.why,item.source,item.id,...Object.keys(item.inputs||{})].filter(Boolean).join(' ').toLowerCase(); }
// A bounded, local projection of existing records. Shared words are suggestions,
// never saved relationships, causal claims, or proof that a decision is correct.
function buildProjectMap(data, { query = '', focus = 'project', kind = 'all' } = {}) {
  const body = item => [item.text, item.answer, item.title, item.why, item.source].filter(Boolean).join(' ');
  const label = item => {
    const text=/^record\.[0-9a-f-]{36}$/i.test(item.id) ? item.text : item.id.replace(/^(?:record|decision|answer|check|next|goal)\./, '').replace(/[._-]+/g, ' ').replace(/^./, c => c.toUpperCase());
    return text.length>50?text.slice(0,47).trimEnd()+'…':text;
  };
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
function renderMap(restoreFocus = false) {
  if (!state) return;
  $('workspace-name').textContent=state.project_name;
  const model=buildProjectMap(state,{query:$('map-search').value,focus:focusKey,kind:mapKind});
  if (focusKey!=='project'&&!model.nodes.some(node=>node.key===focusKey)) focusKey='project';
  const focus=model.nodes.find(node=>node.key===focusKey);
  $('map-workspace').dataset.focused=String(!!focus);
  const linked=model.edges.filter(edge=>edge.source===focusKey||edge.target===focusKey).sort((a,b)=>(a.type==='suggested')-(b.type==='suggested')||(b.score||0)-(a.score||0));
  const adjacent=new Set(linked.flatMap(edge=>[edge.source,edge.target]));
  const eligible=model.matches.filter(node=>mapKind==='all'||node.kind===mapKind);
  // A small legible neighborhood, with all matching records available in the
  // inspector. The graph is not an exhaustive view of the whole ledger.
  let ranked=[...eligible].sort((a,b)=>Number(b.key===focusKey)-Number(a.key===focusKey)||Number(adjacent.has(b.key))-Number(adjacent.has(a.key)));
  if (focusKey==='project'&&!$('map-search').value.trim()&&mapKind==='all') {
    const picked=[];for(const kind of ['goal','next','answer','decision','check']) picked.push(...ranked.filter(node=>node.kind===kind&&(kind!=='next'||node.item.status!=='done')).slice(0,kind==='goal'?1:2));
    ranked=[...picked,...ranked.filter(node=>!picked.includes(node))];
  }
  const shown=ranked.slice(0,10), visibleKeys=new Set(['project',...shown.map(node=>node.key)]);
  $('map-count').textContent=shown.length+' of '+model.matchingTotal+' entries'+(model.total>120?' · recent context; search to find older entries':'');
  $('map-filters').replaceChildren();
  for(const [kind,name] of [['all','Everything'],['next','Next actions'],['decision','Decisions'],['answer','Answers'],['check','Evidence'],['goal','Goals']]) {
    const node=button(name,()=>{mapKind=kind;focusKey='project';renderMap();[...$('map-filters').children].find(entry=>entry.dataset.kind===kind)?.focus({preventScroll:true});},'map-filter');node.dataset.kind=kind;node.setAttribute('aria-pressed',String(mapKind===kind));$('map-filters').append(node);
  }
  const canvas=$('map-canvas');canvas.replaceChildren();
  const positions=[[18,19],[46,10],[77,17],[85,46],[75,79],[46,88],[18,77],[13,48],[45,29],[47,69]];
  const points=new Map([['project',[48,49]],...shown.map((node,index)=>[node.key,positions[index]])]);
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 1000 640');svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('aria-hidden','true');svg.setAttribute('class','map-lines');
  const visibleEdges=model.edges.filter(edge=>visibleKeys.has(edge.source)&&visibleKeys.has(edge.target));
  const suggestions=visibleEdges.filter(edge=>edge.type==='suggested').sort((a,b)=>(Number(b.source===focusKey||b.target===focusKey)-Number(a.source===focusKey||a.target===focusKey))||b.score-a.score).slice(0,10);
  for(const edge of [...visibleEdges.filter(edge=>edge.type==='recorded'),...suggestions]) {
    const a=points.get(edge.source),b=points.get(edge.target),line=document.createElementNS('http://www.w3.org/2000/svg','path');
    line.setAttribute('d',`M ${a[0]*10} ${a[1]*6.4} Q ${(a[0]+b[0])*5+20} ${(a[1]+b[1])*3.2-22} ${b[0]*10} ${b[1]*6.4}`);
    line.setAttribute('class','map-line '+edge.type+((edge.source===focusKey||edge.target===focusKey)&&focusKey!=='project'?' focused':''));svg.append(line);
  }
  canvas.append(svg);
  let focusedButton;
  for(const node of [{key:'project',kind:'project',label:state.project_name},...shown]) {
    const active=node.key===focusKey;
    const entry=button('',()=>{focusKey=node.key;renderMap(true);},'map-node'+(active?' selected':'')+(focusKey!=='project'&&!adjacent.has(node.key)&&node.key!=='project'?' subdued':''));
    entry.dataset.kind=node.kind;entry.dataset.nodeKey=node.key;entry.style.left=points.get(node.key)[0]+'%';entry.style.top=points.get(node.key)[1]+'%';entry.setAttribute('aria-pressed',String(active));entry.setAttribute('aria-label',(node.kind==='project'?'Project':labels[node.kind])+': '+(node.item?.text||node.item?.title||node.label));
    const dot=el('span',undefined,'node-dot');dot.setAttribute('aria-hidden','true');
    entry.append(dot,el('span',node.label,'node-label'),el('span',node.kind==='project'?model.total+' entries':node.kind==='check'?(node.item.freshness==='inputs-match'?'Inputs match':'Needs review'):node.kind==='next'?(node.item.status==='done'?'Completed':'Next action'):labels[node.kind],'node-kind'));
    canvas.append(entry);if(active)focusedButton=entry;
  }
  if(!shown.length)canvas.append(el('p',$('map-search').value?'No matching entries. Try another term.':'No entries in this category yet.','map-empty'));
  const panel=$('map-inspector');panel.replaceChildren();
  if(focus)panel.append(button('← Back to project',()=>{focusKey='project';renderMap(true);},'inspector-back'));
  const panelTitle=el('h2',focus?focus.label:state.project_name);panelTitle.tabIndex=-1;
  panel.append(el('p',focus?'IN FOCUS':'PROJECT BRIEF','inspector-eyebrow'),panelTitle);
  if(focus) {
    const card=focus.kind==='check'?checkCard(focus.item):recordCard(focus.item);card.className+=' expanded';panel.append(card);
    const connections=el('div',undefined,'inspector-connections');connections.append(el('h3','Connected context'));
    const relevant=linked.filter(edge=>edge.source!=='project'&&edge.target!=='project').slice(0,8);
    if(!relevant.length)connections.append(el('p','No direct references or strong shared topics found. This entry still belongs to the project.','connection-note'));
    for(const edge of relevant) {
      const other=model.nodes.find(node=>node.key===(edge.source===focusKey?edge.target:edge.source));
      const row=button('',()=>{focusKey=other.key;mapKind='all';$('map-search').value='';renderMap(true);},'connection-row');
      row.append(el('span',edge.type==='recorded'?'RECORDED LINK':'SUGGESTED LINK','connection-type '+edge.type),el('strong',other.label),el('span',edge.label,'connection-reason'));connections.append(row);
    }
    panel.append(connections);
  } else {
    const goal=state.records.filter(item=>item.kind==='goal').sort((a,b)=>b.revision-a.revision)[0];
    panel.append(el('p',goal?.text||'Start with an answer, a decision or a next action. Connections appear as your project record grows.','project-brief'));
    panel.append(el('p','Select an entry to read the full context and see why it is connected.','inspector-hint'));
    panel.append(button('+ Add project context',()=>edit(), 'map-add'));
    const index=el('div',undefined,'inspector-index');index.append(el('h3',$('map-search').value?'Search results':mapKind==='all'?'Explore the threads':labels[mapKind]));
    for(const node of ranked.slice(0,24)) {const row=button('',()=>{focusKey=node.key;renderMap(true);},'index-entry');row.dataset.kind=node.kind;row.setAttribute('aria-label',labels[node.kind]+': '+node.label);row.append(el('i'),el('span',node.label),el('span','↗'));index.append(row);}
    if(ranked.length>24)index.append(el('p','Search to narrow '+ranked.length+' matching entries.','connection-note'));
    panel.append(index);
  }
  panel.scrollTop=0;
  // In narrow windows the detail panel follows the map in normal flow. Move
  // focus to its heading so the selected context is visible without an overlay.
  if(restoreFocus)(focus?panelTitle:focusedButton)?.focus();
}
function setView(mode) {
  viewMode=mode;$('map-workspace').hidden=mode!=='map';$('records-workspace').hidden=mode!=='records';
  $('show-map').setAttribute('aria-pressed',String(mode==='map'));$('show-records').setAttribute('aria-pressed',String(mode==='records'));
  $('skip-link').setAttribute('href',mode==='map'?'#map-title':'#section-title');
  if(mode==='map')renderMap();
}
function notice(message, error = false, undo) {
  $('notice').replaceChildren(); const node = el('div', undefined, 'notice' + (error ? ' error' : '')); node.append(el('span', message));
  if (undo) node.append(button('Undo', undo)); $('notice').append(node);
  $('map-notice').replaceChildren();const mapMessage=el('div',undefined,'notice'+(error?' error':''));mapMessage.append(el('span',message));if(undo)mapMessage.append(button('Undo',undo));$('map-notice').append(mapMessage);
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
    const node = button('', () => { selected = key; $('search').value = ''; render(); $('section-title').focus(); });
    const icon = el('span', undefined, 'nav-icon icon-' + key); icon.setAttribute('aria-hidden', 'true'); node.append(icon, el('span', label, 'nav-name'));
    if (selected === key) node.setAttribute('aria-current', 'page');
    if (count !== null) node.append(el('span', count, 'count')); $('navigation').append(node);
  }
}
function summary() {
  const entries = [
    ['next', state.records.filter(r => r.kind === 'next' && r.status !== 'done').length, 'Open actions'],
    ['answer', state.records.filter(r => r.kind === 'answer').length, 'Answers saved'],
    ['check', state.checks.filter(r => r.freshness !== 'inputs-match').length, 'Checks to review'],
  ];
  $('summary').replaceChildren();
  for (const [kind, count, label] of entries) {
    const node = button('', () => { selected = kind; $('search').value = ''; render(); $('section-title').focus(); }, 'summary-item' + (kind === 'check' && count ? ' needs-attention' : ''));
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
  const heading = el('div', undefined, 'card-heading'); heading.append(el('span', removed ? 'REMOVED' : kind, 'badge' + (removed ? ' neutral' : '')), el('span', new Date(item.recorded_at).toLocaleDateString([], { month:'short', day:'numeric' }), 'record-date')); card.append(heading);
  const copy = el('div', undefined, 'record-copy'); copy.append(el('h3', item.text)); if (item.answer) copy.append(el('p', item.answer, 'answer')); card.append(copy);
  if (item.text.length > 200 || item.answer?.length > 220) {
    card.className += ' has-preview';
    let expanded = false;
    const more = button('Read full entry', () => { expanded = !expanded; card.className = card.className.replace(' expanded', '') + (expanded ? ' expanded' : ''); more.textContent = expanded ? 'Show less' : 'Read full entry'; more.setAttribute('aria-expanded', String(expanded)); }, 'read-more');
    more.setAttribute('aria-expanded', 'false'); card.append(more);
  }
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
function matches(item) { const query = $('search').value.toLowerCase().trim(); return !query || searchableText(item).includes(query); }
function group(kind, items, limit = Infinity) {
  const section = el('section', undefined, 'group'); const heading = el('div', undefined, 'group-title'); heading.append(el('h3', labels[kind]));
  if (selected === 'overview') heading.append(button('View all →', () => { selected = kind; render(); $('section-title').focus(); }));
  if (selected === 'overview') section.append(heading);
  const cards = el('div', undefined, 'cards'); items.filter(matches).slice(0, limit).forEach(item => cards.append(kind === 'check' ? checkCard(item) : recordCard(item))); section.append(cards); return section;
}
function render() {
  if (!state) return;
  renderAfterEditor = false; $('add').disabled = busy;
  nav(); summary(); $('project').replaceChildren(el('span', state.project_name, 'project-name'), el('span', state.branch || 'No Git branch', 'branch-name'));
  $('revision').textContent = `Handoff revision ${state.revision}. Refreshed ${new Date().toLocaleTimeString()}.`;
  $('section-title').textContent = labels[selected]; $('section-description').textContent = descriptions[selected];
  $('goal').replaceChildren();
  $('summary').hidden = selected !== 'overview';
  if (selected === 'overview') {
    const goal = state.records.filter(r => r.kind === 'goal').sort((a,b) => b.revision - a.revision)[0];
    if (goal) {
      const node = el('details', undefined, 'goal');
      node.append(el('summary', 'Current focus'), el('p', goal.text), button('Edit goal', () => edit(goal), 'quiet')); $('goal').append(node);
    }
  }
  const content = $('content'); content.replaceChildren();
  if (selected === 'removed') {
    const cards = el('div', undefined, 'cards'); state.removed.filter(r => matches(r.item)).forEach(r => cards.append(r.category === 'check' ? checkCard(r.item, true) : recordCard(r.item, true))); content.append(cards);
  } else if (selected === 'overview') {
    for (const kind of ['next','answer','check','decision']) {
      let items = [...(kind === 'check' ? state.checks : state.records.filter(r => r.kind === kind))].sort((a,b) => b.revision - a.revision);
      if (kind === 'next') items = items.filter(item => item.status !== 'done');
      if (kind === 'check') items.sort((a,b) => (a.freshness === 'inputs-match') - (b.freshness === 'inputs-match') || b.revision - a.revision);
      if (items.some(matches)) content.append(group(kind, items, 2));
    }
  } else {
    const items = [...(selected === 'check' ? state.checks : state.records.filter(r => r.kind === selected))].sort((a,b) => b.revision - a.revision);
    if (selected === 'next') items.sort((a,b) => (a.status === 'done') - (b.status === 'done') || b.revision - a.revision);
    if (selected === 'check') items.sort((a,b) => (a.freshness === 'inputs-match') - (b.freshness === 'inputs-match') || b.revision - a.revision);
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
    if (viewMode === 'map') { focusKey = 'record:' + submitted.id; renderMap(); }
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
  const card = [...document.querySelectorAll('[data-record-id]')].find(node => node.dataset.recordId === editing?.id);
  (editorOpener?.isConnected ? editorOpener : card?.querySelector('.card-actions button') || (editing?.item?.kind === 'goal' && $('goal').querySelector('button')) || $('add')).focus();
  editing = null; latestEdit = null;
});
$('editor').addEventListener('cancel', event => { if (editing?.saving) event.preventDefault(); });
$('kind').addEventListener('change', kindFields); $('cancel').addEventListener('click', () => $('editor').close()); $('cancel-top').addEventListener('click', () => $('editor').close());
$('add').addEventListener('click', () => edit()); $('refresh').addEventListener('click', refresh); $('search').addEventListener('input', render);
$('show-map').addEventListener('click',()=>setView('map'));$('show-records').addEventListener('click',()=>setView('records'));
$('map-search').addEventListener('input',()=>{focusKey='project';renderMap();});$('map-reset').addEventListener('click',()=>{focusKey='project';mapKind='all';$('map-search').value='';renderMap();});$('map-refresh').addEventListener('click',refresh);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('editor').open && !busy) refresh(); });
refresh();
