// Exercise the shipped browser event handlers with a deterministic DOM/transport.
// Actual browser checks complement this harness; no browser package is required.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

class Node {
  constructor(tag, doc) { this.tagName=tag; this.doc=doc; this.children=[]; this.listeners={}; this.dataset={}; this.value=''; this.hidden=false; this.disabled=false; this.attributes={}; this.ownText=''; }
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
  querySelector(selector){return this.descendants().find(n=>selector==='button'?n.tagName==='button':selector==='.card'?n.className?.split(' ').includes('card'):selector==='[data-record-id]'?n.dataset.recordId:false);}
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
 return {nodes,doc,requests,current,findButton,respond,expire:()=>[...timers.values()].forEach(fn=>fn())};
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
let failures=0;
for(const {name,fn} of cases){try{await fn();console.log('PASS '+name);}catch(error){failures++;console.error('FAIL '+name+'\n'+error.message);}}
console.log(`${cases.length-failures}/${cases.length} UI recovery scenarios passed`);process.exitCode=failures?1:0;
