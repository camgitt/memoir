import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startWorkView } from './src/work/view.js';
import { recordWork, readWork, runWorkCheck, resumeWork, reviewWork } from './src/work/store.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-view-'));
let view, count = 0;
async function test(name, fn) { await fn(); count++; console.log('PASS ' + name); }
const saved = { id:'answer.fixture', kind:'answer', text:'Delivery?', answer:'Local review', source:'Synthetic view fixture' };
const first = await recordWork(root, saved);
try {
  view = await startWorkView(root);
  const token = new URLSearchParams(new URL(view.url).hash.slice(1)).get('token');
  const auth = { Authorization:'Bearer '+token };
  const send = (input, headers = {}) => fetch(view.origin+'/api/action', { method:'POST', headers:{...auth, Origin:view.origin, 'Content-Type':'application/json', ...headers}, body:JSON.stringify(input) });
  const mutation = { action:'save', id:saved.id, expected_revision:first.revision, branch:null, fields:{kind:saved.kind,text:saved.text,answer:'Corrected answer',status:'open'} };
  await test('view listens on IPv4 loopback and keeps its capability out of the URL query', async () => {
    assert.equal(view.server.address().address,'127.0.0.1'); assert.equal(new URL(view.url).search,''); assert.ok(token.length >= 40);
  });
  await test('static page contains no project data and carries strict browser headers', async () => {
    const response = await fetch(view.origin);
    const html=await response.text(); assert.equal(response.status,200); assert.ok(!html.includes('Local review'));
    assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);
    assert.match(response.headers.get('content-security-policy'),/img-src 'none'/);
    assert.equal(response.headers.get('cache-control'),'no-store'); assert.equal(response.headers.get('referrer-policy'),'no-referrer');
  });
  await test('project data requires the per-process capability', async () => {
    for(const headers of [{},{Authorization:'Bearer incorrect'}]) assert.equal((await fetch(view.origin+'/api/state',{headers})).status,401);
    const response=await fetch(view.origin+'/api/state',{headers:auth}); assert.equal(response.status,200); assert.equal((await response.json()).records[0].answer,'Local review');
  });
  await test('host rebinding, cross-origin calls and preflight are refused', async () => {
    // fetch normalizes Host; use the wire-level client for a real rebinding probe.
    const wrongHostStatus = await new Promise((resolve, reject) => {
      const request = http.get(view.origin+'/api/state', {headers:{...auth,Host:'attacker.invalid'}}, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
    });
    assert.equal(wrongHostStatus,403);
    assert.equal((await fetch(view.origin+'/api/state',{headers:{...auth,Origin:'https://attacker.invalid'}})).status,403);
    const preflight=await fetch(view.origin+'/api/action',{method:'OPTIONS',headers:{Origin:'https://attacker.invalid','Access-Control-Request-Headers':'authorization'}});
    assert.equal(preflight.status,403); assert.equal(preflight.headers.get('access-control-allow-origin'),null);
  });
  await test('writes require exact origin, JSON and an authenticated POST', async () => {
    assert.equal((await send(mutation,{Origin:''})).status,403);
    assert.equal((await send(mutation,{'Content-Type':'text/plain'})).status,403);
    assert.equal((await send(mutation,{Authorization:'wrong'})).status,401);
    assert.equal((await fetch(view.origin+'/api/action',{headers:auth})).status,405);
    assert.equal((await readWork(root)).revision,first.revision);
  });
  await test('wrong-branch edits and hidden command/settings APIs cannot mutate anything', async () => {
    assert.equal((await send({...mutation,branch:'different'})).status,409);
    assert.equal((await send({...mutation,action:'execute'})).status,409);
    assert.equal((await fetch(view.origin+'/api/check',{method:'POST',headers:{...auth,Origin:view.origin,'Content-Type':'application/json'},body:'{}'})).status,405);
    assert.equal((await readWork(root)).revision,first.revision);
  });
  let corrected;
  await test('a correction updates agent resume and preserves its prior source/history', async () => {
    const response=await send(mutation); assert.equal(response.status,200); const state=await response.json();
    corrected=state.records[0]; assert.equal(corrected.answer,'Corrected answer'); assert.equal(state.history.length,2);
    assert.equal(state.history[0].source,saved.source); assert.equal((await resumeWork(root)).records[0].answer,'Corrected answer');
  });
  await test('stale browser edits cannot overwrite a newer correction', async () => {
    assert.equal((await send(mutation)).status,409); assert.equal((await resumeWork(root)).records[0].answer,'Corrected answer');
  });
  await test('removal hides from agents; restore is durable and rejects stale undo', async () => {
    assert.equal((await send({action:'remove',id:saved.id,expected_revision:corrected.revision,branch:null})).status,200);
    assert.equal((await resumeWork(root)).records.length,0);
    const hiddenEdit = await send({...mutation,expected_revision:corrected.revision});
    assert.equal(hiddenEdit.status,409); assert.equal((await hiddenEdit.json()).code,'refresh_required');
    assert.equal((await resumeWork(root)).records.length,0);
    assert.equal((await reviewWork(root)).removed[0].item.answer,'Corrected answer');
    const restore={action:'restore',id:saved.id,expected_revision:corrected.revision,branch:null};
    assert.equal((await send({...restore,branch:'other'})).status,409);
    assert.equal((await send(restore)).status,200); assert.equal((await resumeWork(root)).records[0].answer,'Corrected answer');
    assert.equal((await send(restore)).status,409);
  });
  await test('personal scope, secrets and oversized request bodies are rejected', async () => {
    const base={action:'save',id:'answer.new',expected_revision:0,branch:null,fields:{kind:'answer',text:'Fixture?',answer:'Normal',status:'open'}};
    assert.equal((await send({...base,fields:{...base.fields,scope:'personal'}})).status,409);
    const secret='sk_test_'+'z'.repeat(30);
    const response=await send({...base,fields:{...base.fields,answer:secret}}); assert.equal(response.status,409); assert.ok(!(await response.text()).includes(secret));
    assert.equal((await send({...base,unused:'x'.repeat(20000)})).status,409);
    assert.ok(!(await fs.readFile(path.join(root,'.memoir/work.json'),'utf8')).includes(secret));
  });
  await test('arbitrary filesystem routes are unavailable', async () => {
    for(const route of ['/work.json','/.memoir/work.json','/src/work/store.js','/%2e%2e%2fpackage.json']) assert.equal((await fetch(view.origin+route,{headers:auth})).status,404);
  });
  await test('check receipts cannot be edited or restored into a pass by the view', async () => {
    await fs.writeFile(path.join(root,'fixture.cjs'),'process.exit(0);');
    const receipt=await runWorkCheck(root,{id:'fixture.check',title:'Fixture check',command:[process.execPath,'fixture.cjs'],files:['fixture.cjs']});
    assert.equal((await send({...mutation,category:'check',id:receipt.id,expected_revision:receipt.revision})).status,400);
    assert.equal((await send({action:'remove',id:receipt.id,expected_revision:receipt.revision,category:'check',branch:null})).status,200);
    assert.equal((await send({action:'restore',id:receipt.id,expected_revision:receipt.revision,category:'check',branch:null})).status,400);
    assert.equal((await resumeWork(root)).checks.length,0);
  });
  await test('project data is rendered as text with no markup execution sink', async () => {
    const response=await fetch(view.origin+'/app.js'); const app=await response.text();
    assert.doesNotMatch(app,/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(/);
    assert.match(app,/textContent/); assert.match(app,/history\.replaceState/);
  });
  await test('a new viewer process rejects an old capability and resumes saved corrections', async () => {
    await view.close(); view=await startWorkView(root);
    assert.equal((await fetch(view.origin+'/api/state',{headers:auth})).status,401);
    assert.equal((await resumeWork(root)).records[0].answer,'Corrected answer');
  });
  console.log(`${count} local view groups passed`);
} finally { if(view) await view.close(); await fs.remove(root); }
