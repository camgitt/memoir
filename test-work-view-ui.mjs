// Exercise the shipped browser event handlers with a deterministic DOM/transport.
// Actual browser checks complement this harness; no browser package is required.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

class Node {
  constructor(tag, doc) { this.tagName=tag; this.doc=doc; this.children=[]; this.listeners={}; this.dataset={}; this.style={}; this.value=''; this.hidden=false; this.disabled=false; this.attributes={}; this.ownText=''; }
  get textContent(){return this.ownText+this.children.map(n=>n.textContent).join('');}
  set textContent(text){this.ownText=String(text); this.children=[];}
  append(...nodes){for(const node of nodes){node.parent=this; this.children.push(node);}}
  replaceChildren(...nodes){for(const node of this.children) node.parent=null; this.children=[]; this.ownText=''; this.append(...nodes);}
  setAttribute(name,value){this.attributes[name]=value;}
  addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);}
  async emit(name){const event={preventDefault(){this.defaultPrevented=true;},defaultPrevented:false}; for(const fn of this.listeners[name]??[]) await fn(event); return event;}
  click(){return this.disabled?Promise.resolve():this.emit('click');}
  focus(){this.doc.activeElement=this;}
  get isConnected(){return this.root || !!this.parent?.isConnected;}
  showModal(){this.open=true;}
  close(){this.open=false; queueMicrotask(()=>this.emit('close'));}
  descendants(){return this.children.flatMap(n=>[n,...n.descendants()]);}
  querySelectorAll(selector){return this.descendants().filter(n=>selector==='[data-record-id]'&&n.dataset.recordId);}
  querySelector(selector){return this.descendants().find(n=>selector==='button'?n.tagName==='button':selector==='.card-actions button'?n.tagName==='button'&&n.parent?.className?.split(' ').includes('card-actions'):selector==='.card'?n.className?.split(' ').includes('card'):selector==='[data-record-id]'?n.dataset.recordId:false);}
}
const source=await fs.readFile(new URL('./src/work/ui/app.js',import.meta.url),'utf8');
const html=await fs.readFile(new URL('./src/work/ui/index.html',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function snapshot(revision=1,answer='Original answer'){
 const record={id:'answer.fixture',kind:'answer',text:'Fixture question?',answer,status:'open',source:'Fixture',revision,recorded_at:'2026-09-06T00:00:00Z'};
 return {revision,branch:'main',project_name:'fixture',records:[record],checks:[],history:[record],removed:[]};
}
async function browser({storageFails=false,load=true}={}){
 const doc={activeElement:null,hidden:false,listeners:{},addEventListener:Node.prototype.addEventListener,emit:Node.prototype.emit};
 const nodes=new Map([...html.matchAll(/id="([^"]+)"/g)].map(([,id])=>{const node=new Node(id==='editor'?'dialog':'div',doc);node.id=id;node.root=true;return [id,node];}));
 nodes.get('kind').value='answer'; nodes.get('status').value='open';
 doc.getElementById=id=>nodes.get(id);
 doc.createElement=tag=>new Node(tag,doc);
 doc.createElementNS=(_namespace,tag)=>new Node(tag,doc);
 doc.querySelectorAll=selector=>[...nodes.values()].flatMap(n=>n.descendants()).filter(n=>selector==='[data-record-id]'&&n.dataset.recordId);
 const requests=[], timers=new Map(); let timerId=0;
 const sessionStorage={getItem(){if(storageFails)throw Error('Storage unavailable');return 'synthetic-token';},setItem(){if(storageFails)throw Error('Storage unavailable');}};
 const context={document:doc,location:{hash:'#token=synthetic-token'},history:{replaceState(){}},sessionStorage,URLSearchParams,crypto:{randomUUID},AbortController,setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),
  fetch:(route,options)=>new Promise((resolve,reject)=>{options.signal?.addEventListener('abort',()=>reject(Error('Aborted'))); requests.push({route,options,resolve:body=>resolve({ok:true,status:200,json:async()=>body}),reject});}),console};
 vm.runInNewContext(source,context);
 const current=()=>nodes.get('content').textContent;
 const findButton=text=>nodes.get('content').descendants().find(n=>n.tagName==='button'&&n.textContent===text);
 const respond=async(index,state)=>{requests[index].resolve(state);await tick();};
 if(load) await respond(0,snapshot());
 return {nodes,doc,requests,current,findButton,respond,buildMap:context.buildProjectMap,expire:()=>[...timers.values()].forEach(fn=>fn())};
}
const cases=[]; const test=(name,fn)=>cases.push({name,fn});
test('late refresh cannot replace a successful correction with stale data',async()=>{
 const b=await browser(); const pendingRefresh=b.nodes.get('refresh').click();
 await b.findButton('Correct').click(); b.nodes.get('answer').value='Corrected answer';
 const save=b.nodes.get('edit-form').emit('submit'); await b.respond(2,snapshot(2,'Corrected answer')); await save;
 await b.respond(1,snapshot()); await pendingRefresh;
 assert.match(b.current(),/Corrected answer/); assert.doesNotMatch(b.current(),/Original answer/);
});
test('slow save cannot close a different draft',async()=>{
 const b=await browser(); await b.findButton('Correct').click();
 const save=b.nodes.get('edit-form').emit('submit');
 await b.nodes.get('cancel').click();
 if(!b.nodes.get('editor').open){await b.nodes.get('add').click(); b.nodes.get('text').value='Second draft';}
 const second=b.nodes.get('text').value==='Second draft';
 await b.respond(1,snapshot(2,'Saved answer')); await save; await tick();
 if(second){assert.equal(b.nodes.get('editor').open,true);assert.equal(b.nodes.get('text').value,'Second draft');}
 assert.doesNotMatch(b.nodes.get('form-error').textContent,/Cannot read|undefined|null/);
});
test('retrying a new record after a dropped response keeps the same record ID',async()=>{
 const b=await browser();await b.nodes.get('add').click();b.nodes.get('text').value='New question';b.nodes.get('answer').value='New answer';
 const first=b.nodes.get('edit-form').emit('submit');b.requests[1].reject(Error('Connection dropped'));await first;
 const second=b.nodes.get('edit-form').emit('submit');
 assert.equal(JSON.parse(b.requests[1].options.body).id,JSON.parse(b.requests[2].options.body).id);
 b.requests[2].resolve(snapshot(2));await second;
});
test('cancel after comparing a concurrent correction shows the latest saved state',async()=>{
 const b=await browser();await b.findButton('Correct').click();
 const compare=b.nodes.get('review-latest').click();await b.respond(1,snapshot(2,'Concurrent correction'));await compare;
 await b.nodes.get('cancel').click();await tick();assert.match(b.current(),/Concurrent correction/);
});
test('Add memory cannot open before the initial context loads',async()=>{
 const b=await browser({load:false}); await b.nodes.get('add').click(); assert.ok(!b.nodes.get('editor').open);
 await b.respond(0,snapshot()); await b.nodes.get('add').click(); assert.equal(b.nodes.get('editor').open,true);
});
test('storage restrictions do not prevent use of the active launch link',async()=>{
 const b=await browser({storageFails:true});assert.match(b.current(),/Original answer/);
});
test('an older refresh cannot replace a later refresh',async()=>{
 const b=await browser(); const first=b.nodes.get('refresh').click(), second=b.nodes.get('refresh').click();
 await b.respond(2,snapshot(3,'Newest answer'));await second;await b.respond(1,snapshot(2,'Older answer'));await first;
 assert.match(b.current(),/Newest answer/);assert.doesNotMatch(b.current(),/Older answer/);
});
test('a comparison response cannot overwrite a newly opened editor',async()=>{
 const b=await browser();await b.findButton('Correct').click();const compare=b.nodes.get('review-latest').click();
 await b.nodes.get('cancel').click();await tick();await b.nodes.get('add').click();b.nodes.get('text').value='New draft';
 await b.respond(1,snapshot(2,'Later saved version'));await compare;
 assert.equal(b.nodes.get('text').value,'New draft');assert.equal(b.nodes.get('comparison').hidden,true);assert.equal(b.nodes.get('editor').open,true);
});
test('timed out saves release the editor and report an uncertain outcome',async()=>{
 const b=await browser();await b.findButton('Correct').click();const save=b.nodes.get('edit-form').emit('submit');
 assert.equal((await b.nodes.get('editor').emit('cancel')).defaultPrevented,true);
 assert.equal(b.nodes.get('cancel').disabled,true);b.expire();await save;
 assert.equal(b.nodes.get('cancel').disabled,false);assert.equal(b.nodes.get('save').disabled,false);
 assert.equal(b.nodes.get('editor').open,true);assert.match(b.nodes.get('form-error').textContent,/may already be saved/);
 assert.equal(b.nodes.get('review-latest').hidden,false);
});
test('a new record with a lost acknowledgement can be reviewed and corrected',async()=>{
 const b=await browser();await b.nodes.get('add').click();b.nodes.get('text').value='New question';b.nodes.get('answer').value='New answer';
 const save=b.nodes.get('edit-form').emit('submit');const id=JSON.parse(b.requests[1].options.body).id;
 b.requests[1].reject(Error('Lost acknowledgement'));await save;
 const result=snapshot(2,'New answer');result.records[0].id=id;result.records[0].text='New question';
 const compare=b.nodes.get('review-latest').click();await b.respond(2,result);await compare;
 assert.equal(b.nodes.get('comparison').hidden,false);await b.nodes.get('keep-draft').click();
 const correction=b.nodes.get('edit-form').emit('submit');const input=JSON.parse(b.requests[3].options.body);
 assert.equal(input.id,id);assert.equal(input.expected_revision,2);
  await b.respond(3,result);await correction;
});
test('overview prioritizes open work and stale checks; summary opens the complete list',async()=>{
 const b=await browser({load:false}),s=snapshot();
 const base=s.records[0];
 s.records.push({...base,id:'next.open',kind:'next',text:'Open action',answer:undefined,status:'open'}, {...base,id:'next.done',kind:'next',text:'Completed action',answer:undefined,status:'done',revision:9});
 s.checks=[{id:'check.fresh',title:'Matching files',freshness:'inputs-match',reasons:[],inputs:{},recorded_at:base.recorded_at,revision:8}, {id:'check.stale',title:'Changed files',freshness:'stale',reasons:['Changed input: app.js'],inputs:{},recorded_at:base.recorded_at,revision:2}];
 await b.respond(0,s);
 assert.match(b.current(),/Open action/);assert.doesNotMatch(b.current(),/Completed action/);
 assert.match(b.current(),/Changed files/);assert.doesNotMatch(b.current(),/Matching files/);
 const summary=b.nodes.get('summary');assert.match(summary.textContent,/1Open actions/);assert.match(summary.textContent,/1Checks to review/);
 await summary.children[0].click();assert.match(b.current(),/Completed action/);assert.ok(b.current().indexOf('Open action')<b.current().indexOf('Completed action'));
});
test('long entries can be expanded without changing the saved record',async()=>{
 const b=await browser({load:false}),s=snapshot(1,'A long saved answer. '.repeat(30));await b.respond(0,s);
 await b.nodes.get('navigation').children.find(n=>n.dataset.kind==='answer').click();
 const more=b.findButton('Read full entry');assert.equal(more.attributes['aria-expanded'],'false');await more.click();
 assert.equal(more.textContent,'Show less');assert.equal(more.attributes['aria-expanded'],'true');assert.equal(b.requests.length,1);
 await more.click();assert.equal(more.attributes['aria-expanded'],'false');assert.match(b.current(),/A long saved answer/);
});
test('map labels shared words as suggestions and exact record references as recorded links',async()=>{
 const b=await browser(),s=snapshot();s.records=[
  {...s.records[0],id:'decision.database',kind:'decision',text:'Postgres schema migration allocator',answer:undefined},
  {...s.records[0],id:'next.database',kind:'next',text:'Postgres schema migration allocator rollout',answer:undefined},
  {...s.records[0],id:'next.reference',kind:'next',text:'Follow decision.database.',answer:undefined}
 ];
 const graph=b.buildMap(s);const edge=(a,c)=>graph.edges.find(e=>e.source==='record:'+a&&e.target==='record:'+c||e.target==='record:'+a&&e.source==='record:'+c);
 assert.equal(edge('decision.database','next.database').type,'suggested');assert.match(edge('decision.database','next.database').label,/not a saved relationship/);
 assert.equal(edge('decision.database','next.reference').type,'recorded');
 s.records[2].text='Follow decision.database.extended';assert.notEqual(b.buildMap(s).edges.find(e=>e.source==='record:decision.database'&&e.target==='record:next.reference')?.type,'recorded');
 // Dates and build numbers alone do not establish a shared topic.
 s.records=s.records.slice(0,2).map(item=>({...item,text:'2026 1000 2000 recorded settings',source:undefined}));
 assert.equal(b.buildMap(s).edges.filter(e=>e.type==='suggested').length,0);
});
test('map file links describe declared inputs without claiming they verify a decision',async()=>{
 const b=await browser(),s=snapshot();s.records[0].text='Review src/work/view.js';s.checks=[{id:'check.view',title:'View checks',inputs:{'src/work/view.js':'hash'},revision:2}];
 const edge=b.buildMap(s).edges.find(e=>e.source!=='project');assert.equal(edge.type,'recorded');assert.match(edge.label,/does not verify/);
 assert.equal(b.buildMap(s,{query:'src/work/view.js',kind:'check'}).matches[0].item.id,'check.view');
 s.records[0].text='Review src/work/view.js.backup';assert.equal(b.buildMap(s).edges.filter(e=>e.source!=='project'&&e.type==='recorded').length,0);
});
test('map bounds large projects, searches older entries and excludes removed history',async()=>{
 const b=await browser(),s=snapshot();const original=s.records[0];s.records=Array.from({length:150},(_,i)=>({...original,id:'answer.'+i,revision:i+1,text:i===0?'Rare oldest marker':'Ordinary entry '+i,answer:'A synthetic answer'}));s.removed=[{item:{...original,id:'answer.removed',text:'Removed item'}}];s.history.push({...original,id:'answer.history'});
 assert.equal(b.buildMap(s).nodes.length,120);const searched=b.buildMap(s,{query:'Rare oldest marker'});assert.equal(searched.matches.length,1);assert.equal(searched.matches[0].item.id,'answer.0');assert.equal(searched.total,150);
 assert.ok(!searched.nodes.some(n=>n.item.id==='answer.removed'||n.item.id==='answer.history'));
 s.records[0].kind='goal';assert.equal(b.buildMap(s,{kind:'goal'}).matches[0].item.id,'answer.0');
});
test('map navigation and record editing share the same current record',async()=>{
 const b=await browser();const node=b.nodes.get('map-canvas').children.find(n=>n.dataset.nodeKey==='record:answer.fixture');await node.click();
 assert.match(b.nodes.get('map-inspector').textContent,/Original answer/);
 const correct=b.nodes.get('map-inspector').descendants().find(n=>n.tagName==='button'&&n.textContent==='Correct');await correct.click();assert.equal(b.nodes.get('answer').value,'Original answer');
 await b.nodes.get('cancel').click();await tick();await b.nodes.get('show-records').click();assert.equal(b.nodes.get('map-workspace').hidden,true);assert.equal(b.nodes.get('records-workspace').hidden,false);
 assert.equal(b.requests.length,1);
});
test('map category filtering keeps focus on a connected filter control',async()=>{
 const b=await browser();await b.nodes.get('show-map').click();const filter=b.nodes.get('navigation').children.find(n=>n.dataset.kind==='answer');filter.focus();await filter.click();
 assert.equal(b.doc.activeElement.isConnected,true);assert.equal(b.doc.activeElement.dataset.kind,'answer');assert.equal(b.doc.activeElement.attributes['aria-current'],'page');
});
test('opening map context focuses its heading and returning focuses the project',async()=>{
 const b=await browser();await b.nodes.get('map-canvas').children.find(n=>n.dataset.nodeKey==='record:answer.fixture').click();
 assert.equal(b.doc.activeElement.tagName,'h2');assert.equal(b.doc.activeElement.textContent,'Fixture');
 await b.nodes.get('map-inspector').children.find(n=>n.tagName==='button').click();assert.equal(b.doc.activeElement.dataset.nodeKey,'project');assert.equal(b.doc.activeElement.isConnected,true);
});
test('Records and Map both find checks by covered files and records by source',async()=>{
 const b=await browser({load:false}),s=snapshot();s.checks=[{id:'check.fixture',title:'Covered document',inputs:{'docs/guide.md':'hash'},freshness:'inputs-match',reasons:[],revision:2,recorded_at:s.records[0].recorded_at}];s.records[0].source='Dedicated source marker';await b.respond(0,s);
 await b.nodes.get('show-records').click();await b.nodes.get('navigation').children.find(n=>n.textContent==='Checks1').click();b.nodes.get('search').value='docs/guide.md';await b.nodes.get('search').emit('input');
 assert.match(b.current(),/Covered document/);assert.equal(b.buildMap(s,{query:'docs/guide.md'}).matches[0].item.id,'check.fixture');
 await b.nodes.get('navigation').children.find(n=>n.textContent==='Answers1').click();b.nodes.get('search').value='Dedicated source marker';await b.nodes.get('search').emit('input');assert.match(b.current(),/Original answer/);
});
test('saving new context from the map selects the saved entry and keeps focus visible',async()=>{
 const b=await browser();await b.nodes.get('show-map').click();const add=b.nodes.get('map-inspector').children.find(n=>n.textContent==='+ Add project context');add.focus();await add.click();b.nodes.get('text').value='New map question with extended context. '.repeat(8);b.nodes.get('answer').value='Saved through map';
 const save=b.nodes.get('edit-form').emit('submit');const s=snapshot(2);const submitted=JSON.parse(b.requests[1].options.body);s.records.push({...s.records[0],id:submitted.id,text:submitted.fields.text,answer:submitted.fields.answer});s.history=[...s.records];await b.respond(1,s);await save;await tick();
 assert.match(b.nodes.get('map-inspector').textContent,/Saved through map/);assert.equal(b.doc.activeElement.isConnected,true);assert.equal(b.doc.activeElement.textContent,'Correct');
 assert.ok(b.nodes.get('map-inspector').descendants().includes(b.doc.activeElement),'Focus must stay in the visible map, not its hidden Records copy');
});
test('map renders hostile markup as literal text and does not import removed or history-only payloads',async()=>{
 const b=await browser({load:false}),s=snapshot();s.records[0].text='<img src=x onerror=alert(1)> & <svg onload=alert(2)>';s.records[0].answer='Treat as text';s.removed=[{item:{...s.records[0],id:'answer.removed',text:'Hidden payload'}}];s.history.push({...s.records[0],id:'answer.history',text:'History-only payload'});await b.respond(0,s);
 await b.nodes.get('map-canvas').children.find(n=>n.dataset.nodeKey==='record:answer.fixture').click();const panel=b.nodes.get('map-inspector');assert.match(panel.textContent,/<img src=x onerror=alert\(1\)>/);assert.ok(!panel.descendants().some(n=>['img','svg','script'].includes(n.tagName)));assert.doesNotMatch(b.nodes.get('map-canvas').textContent,/Hidden payload|History-only payload/);
});
test('map overview has at most six spokes and no entry-to-entry clutter',async()=>{
 const b=await browser({load:false}),s=snapshot();const base=s.records[0];s.records=Array.from({length:18},(_,i)=>({...base,id:'decision.'+i,kind:'decision',revision:i+1,text:'Postgres schema migration allocator '+i,answer:undefined}));await b.respond(0,s);
 const canvas=b.nodes.get('map-canvas');const paths=canvas.children.find(n=>n.tagName==='svg').children;
 assert.equal(paths.length,6);assert.equal(canvas.children.filter(n=>n.dataset.nodeKey).length,7);assert.ok(paths.every(n=>!n.attributes.class.includes('suggested')));assert.match(b.nodes.get('map-count').textContent,/6 of 18 entries/);
});
test('focused map includes only direct neighbors and suggestions require an explicit toggle',async()=>{
 const b=await browser({load:false}),s=snapshot();const base=s.records[0];s.records=[
  {...base,id:'decision.database',kind:'decision',text:'Postgres schema migration allocator',answer:undefined},
  {...base,id:'next.reference',kind:'next',text:'Follow decision.database.',answer:undefined},
  {...base,id:'next.topic',kind:'next',text:'Postgres schema migration allocator rollout',answer:undefined},
  {...base,id:'next.unrelated',kind:'next',text:'Prepare illustration assets',answer:undefined}
 ];await b.respond(0,s);await b.nodes.get('map-canvas').children.find(n=>n.dataset.nodeKey==='record:decision.database').click();
 const keys=()=>b.nodes.get('map-canvas').children.filter(n=>n.dataset.nodeKey).map(n=>n.dataset.nodeKey);
 assert.deepEqual(keys(),['record:decision.database','record:next.reference']);assert.doesNotMatch(b.nodes.get('map-inspector').textContent,/SUGGESTED LINK/);
 await b.nodes.get('map-suggestions').click();assert.equal(b.nodes.get('map-suggestions').attributes['aria-pressed'],'true');assert.ok(keys().includes('record:next.topic'));assert.ok(!keys().includes('record:next.unrelated'));assert.match(b.nodes.get('map-inspector').textContent,/SUGGESTED LINK/);
 await b.nodes.get('map-suggestions').click();assert.deepEqual(keys(),['record:decision.database','record:next.reference']);assert.equal(b.requests.length,1);
});
test('switching views preserves the search and category without another request',async()=>{
 const b=await browser();await b.nodes.get('navigation').children.find(n=>n.dataset.kind==='answer').click();
 b.nodes.get('search').value='Original answer';await b.nodes.get('search').emit('input');
 await b.nodes.get('show-map').click();assert.equal(b.nodes.get('search').value,'Original answer');assert.equal(b.nodes.get('section-title').textContent,'Answers');
 assert.match(b.nodes.get('map-count').textContent,/1 of 1 entries/);
 await b.nodes.get('show-records').click();assert.equal(b.nodes.get('section-title').textContent,'Answers');assert.match(b.current(),/Original answer/);assert.equal(b.requests.length,1);
});
test('overview search finds every match, including goals and completed actions',async()=>{
 const b=await browser({load:false}),s=snapshot(),base=s.records[0];
 s.records=Array.from({length:4},(_,i)=>({...base,id:'answer.'+i,answer:'Search marker '+i}));
 s.records.push({...base,id:'goal.marker',kind:'goal',text:'Search marker goal',answer:undefined},{...base,id:'next.marker',kind:'next',text:'Search marker completed action',answer:undefined,status:'done'});
 await b.respond(0,s);b.nodes.get('search').value='Search marker';await b.nodes.get('search').emit('input');
 for(let i=0;i<4;i++)assert.match(b.current(),new RegExp('Search marker '+i));assert.match(b.current(),/Search marker goal/);assert.match(b.current(),/Search marker completed action/);
 await b.nodes.get('show-map').click();assert.match(b.nodes.get('map-count').textContent,/6 of 6 entries/);
});
test('connections open the same record and return to a readable Records entry',async()=>{
 const b=await browser();await b.findButton('Connections').click();assert.equal(b.nodes.get('show-map').attributes['aria-pressed'],'true');assert.match(b.nodes.get('map-inspector').textContent,/Original answer/);
 await b.nodes.get('map-inspector').children.find(n=>n.textContent==='Open in Records ↗').click();assert.equal(b.nodes.get('show-records').attributes['aria-pressed'],'true');assert.equal(b.nodes.get('section-title').textContent,'Answers');assert.match(b.current(),/Original answer/);assert.equal(b.requests.length,1);
});
test('Removed has a records-only recovery route and never enters the active graph',async()=>{
 const b=await browser({load:false}),s=snapshot();s.removed=[{category:'record',item:{...s.records[0],id:'answer.removed',text:'Removed example'}}];await b.respond(0,s);
 await b.nodes.get('show-map').click();await b.nodes.get('navigation').children.find(n=>n.dataset.kind==='removed').click();
 assert.equal(b.nodes.get('show-records').attributes['aria-pressed'],'true');assert.match(b.current(),/Removed example/);assert.doesNotMatch(b.nodes.get('map-canvas').textContent,/Removed example/);
 await b.nodes.get('show-map').click();assert.equal(b.nodes.get('section-title').textContent,'Overview');assert.doesNotMatch(b.nodes.get('map-canvas').textContent,/Removed example/);
});
test('saving from a filtered Records list reveals the new entry in its category',async()=>{
 const b=await browser();b.nodes.get('search').value='no-match';await b.nodes.get('search').emit('input');
 await b.nodes.get('add').click();b.nodes.get('kind').value='decision';b.nodes.get('text').value='Keep the same workspace';
 const save=b.nodes.get('edit-form').emit('submit');const input=JSON.parse(b.requests[1].options.body),s=snapshot(2);
 s.records.push({...s.records[0],id:input.id,kind:'decision',text:input.fields.text,answer:undefined});s.history=[...s.records];await b.respond(1,s);await save;await tick();
 assert.equal(b.nodes.get('search').value,'');assert.equal(b.nodes.get('section-title').textContent,'Decisions');assert.match(b.current(),/Keep the same workspace/);assert.equal(b.nodes.get('editor').open,false);assert.equal(b.doc.activeElement.isConnected,true);
});
test('the brief overview includes every open action and keeps detail disclosures reversible',async()=>{
 const b=await browser({load:false}),s=snapshot(),base=s.records[0];
 s.records=Array.from({length:3},(_,i)=>({...base,id:'next.'+i,kind:'next',text:'Action '+i+'. More implementation details.',answer:undefined,status:'open',revision:i+1}));
 s.records.push({...base,id:'next.done',kind:'next',text:'Finished work',answer:undefined,status:'done'});await b.respond(0,s);
 assert.equal(b.nodes.get('content').dataset.compact,'true');for(let i=0;i<3;i++)assert.match(b.current(),new RegExp('Action '+i));assert.doesNotMatch(b.current(),/Finished work/);
 const details=b.findButton('Details');assert.equal(details.attributes['aria-expanded'],'false');await details.click();assert.equal(details.attributes['aria-expanded'],'true');assert.equal(details.textContent,'Show less');await details.click();assert.equal(details.attributes['aria-expanded'],'false');assert.equal(b.requests.length,1);
});
test('the overview files-match summary opens retained evidence without claiming deployment readiness',async()=>{
 const b=await browser({load:false}),s=snapshot();s.checks=[{id:'check.fresh',title:'Matching files',freshness:'inputs-match',reasons:[],inputs:{},recorded_at:s.records[0].recorded_at,revision:8}];await b.respond(0,s);
 assert.match(b.nodes.get('summary').textContent,/1Checks match files/);assert.doesNotMatch(b.current(),/Matching files/);await b.nodes.get('summary').children[2].click();assert.match(b.current(),/Matching files/);assert.equal(b.requests.length,1);
});
test('an open draft keeps its old recovery generation until the restored version is reviewed',async()=>{
 const b=await browser({load:false}),first={...snapshot(),recovery_id:randomUUID()};await b.respond(0,first);
 await b.findButton('Correct').click();b.nodes.get('answer').value='Draft after recovery';
 const save=b.nodes.get('edit-form').emit('submit');assert.equal(JSON.parse(b.requests[1].options.body).expected_recovery,first.recovery_id);
 b.requests[1].reject(Error('Recovery conflict'));await save;
 const compare=b.nodes.get('review-latest').click(),restored={...snapshot(1,'Recovered version'),recovery_id:randomUUID()};
 await b.respond(2,restored);await compare;assert.equal(b.nodes.get('answer').value,'Draft after recovery');
 await b.nodes.get('keep-draft').click();const retry=b.nodes.get('edit-form').emit('submit');
 assert.equal(JSON.parse(b.requests[3].options.body).expected_recovery,restored.recovery_id);
 await b.respond(3,{...restored,...snapshot(2,'Draft after recovery')});await retry;
});
let failures=0;
for(const {name,fn} of cases){try{await fn();console.log('PASS '+name);}catch(error){failures++;console.error('FAIL '+name+'\n'+error.message);}}
console.log(`${cases.length-failures}/${cases.length} UI recovery scenarios passed`);process.exitCode=failures?1:0;
