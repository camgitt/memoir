// Installed tarball workflow in a synthetic home. No live client configuration.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-packed-smoke-'));
const home = path.join(scratch, 'home'), project = path.join(home, 'project'), install = path.join(scratch, 'install');
const env = {
  PATH: process.env.PATH, HOME: home, USERPROFILE: home,
  APPDATA: path.join(home, 'AppData/Roaming'), XDG_CONFIG_HOME: path.join(home, '.config'),
  CI: '1', DO_NOT_TRACK: '1', MEMOIR_PROJECT_ROOT: project,
  MEMOIR_PASSPHRASE: 'synthetic package smoke recovery secret',
  MEMOIR_WORK_PASSPHRASE: 'synthetic project handoff recovery phrase',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'),
};
for (const key of ['SystemRoot','TEMP','TMP']) if (process.env[key]) env[key] = process.env[key];
const run = (command, args, cwd = repository) => execFileSync(command, args, { cwd, env, encoding: 'utf8', timeout: 180000, stdio: ['ignore','pipe','pipe'] });
let client, viewer;
try {
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(install, { recursive: true });
  const artifact = process.env.MEMOIR_TEST_PACKAGE;
  if (artifact && !/^memoir-cli@[0-9]+\.[0-9]+\.[0-9]+$/.test(artifact)) throw new Error('Choose an exact memoir-cli release for registry validation.');
  const packed = JSON.parse(run('npm', ['pack',...(artifact ? [artifact] : []),'--ignore-scripts','--json','--pack-destination',scratch]))[0];
  assert.ok(!packed.files.some(file => /^(?:\.memoir|\.codex|\.cursor)(?:\/|$)|^AGENTS\.md$/.test(file.path)));
  run('npm', ['install','--ignore-scripts','--no-audit','--no-fund','--prefix',install,'--cache',path.join(scratch,'cache'),path.join(scratch,packed.filename)]);
  const pkg = path.join(install,'node_modules/memoir-cli');
  const cli = args => run(process.execPath, [path.join(pkg,'bin/memoir.js'), ...args], project);
  const version = JSON.parse(await fs.readFile(path.join(pkg,'package.json'))).version;
  assert.match(cli(['--version']), new RegExp(version.replace(/\./g,'\\.')));
  assert.ok((await fs.stat(path.join(pkg,'docs/RELIABILITY-ROLLOUT.md'))).isFile());
  cli(['setup','--tool','all','--project',project]);
  const { Client } = await import(pathToFileURL(path.join(install,'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')));
  const { StdioClientTransport } = await import(pathToFileURL(path.join(install,'node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js')));
  const connect = async () => {
    client = new Client({ name:'package-smoke', version:'1.0.0' });
    await client.connect(new StdioClientTransport({ command:process.execPath,args:[path.join(pkg,'src/mcp.js')],env,stderr:'pipe' }));
  };
  await connect();
  const saved = await client.callTool({ name:'memoir_remember',arguments:{ filename:'package-smoke.md',content:'package-smoke-recovery-marker uses verified snapshots' } });
  assert.notEqual(saved.isError,true);
  const note = await client.callTool({ name:'memoir_note',arguments:{text:'package-continuity-decision',why:'recovery proof'} });
  assert.notEqual(note.isError,true);
  await client.close(); client = null;
  await connect();
  const recalled = await client.callTool({name:'memoir_recall',arguments:{query:'package-smoke-recovery-marker'}});
  assert.match(JSON.stringify(recalled),/verified snapshots/);
  await client.close(); client = null;
  const configDir = path.join(home,'.config/memoir');
  await fs.mkdir(configDir,{recursive:true});
  await fs.writeFile(path.join(configDir,'config.json'),JSON.stringify({version:2,activeProfile:'default',profiles:{default:{provider:'local',localPath:path.join(scratch,'backup'),encrypt:true}}}));
  cli(['push','--only','memoir']); cli(['push','--only','memoir']);
  await fs.rm(path.join(configDir,'memories'),{recursive:true,force:true});
  await fs.rm(path.join(configDir,'session.json'),{force:true});
  cli(['restore']);
  assert.match(cli(['recall','package-smoke-recovery-marker']),/verified snapshots/);
  assert.match(cli(['resume']),/package-continuity-decision/);
  // The project-only route must work from the installed tarball too, while
  // keeping the older personal-memory server and settings intact.
  cli(['work', '--project', project, 'setup']);
  cli(['work', '--project', project, 'record', '--json', JSON.stringify({id:'answer.packed',kind:'answer',text:'Delivery?',answer:'Local review',source:'Package test'})]);
  await fs.writeFile(path.join(project,'check.cjs'),'process.exit(0);\n');
  const receipt = JSON.parse(cli(['work','--project',project,'check','packed','--title','Installed check','--files','check.cjs','--',process.execPath,'check.cjs']));
  assert.equal(receipt.exit_code,0);
  const originalWork = await fs.readFile(path.join(project,'.memoir/work.json'));
  const originalSettings = await fs.readFile(path.join(project,'.cursor/mcp.json'));
  const workExport = path.join(scratch,'project-handoff.memoir');
  cli(['work','backup','--output',workExport]);
  assert.equal(JSON.parse(cli(['work','doctor'])).healthy,true);
  await fs.writeFile(path.join(project,'.memoir/work.json'),'{ synthetic interrupted write');
  const recoveryPreview = JSON.parse(cli(['work','recover','--from',workExport]));
  const recoveredWork = JSON.parse(cli(['work','recover','--from',workExport,'--apply','--expect',recoveryPreview.expect]));
  assert.equal(recoveredWork.applied,true);
  assert.equal(JSON.parse(cli(['work','doctor'])).healthy,true);
  assert.deepEqual(await fs.readFile(path.join(project,'.cursor/mcp.json')),originalSettings);
  const restoredLedger = JSON.parse(await fs.readFile(path.join(project,'.memoir/work.json')));
  assert.deepEqual(restoredLedger.records,JSON.parse(originalWork).records);
  assert.deepEqual(restoredLedger.checks,JSON.parse(originalWork).checks);
  client = new Client({name:'package-work-smoke',version:'1.0.0'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(pkg,'src/work/server.js')],env,stderr:'pipe'}));
  const handoff = await client.callTool({name:'memoir_work_resume',arguments:{}});
  assert.notEqual(handoff.isError,true);
  assert.match(handoff.content[0].text,/Local review/);
  assert.match(handoff.content[0].text,/PASSED; declared inputs still match/);
  assert.doesNotMatch(handoff.content[0].text,/package-continuity-decision|package-smoke-recovery-marker/);
  const staleWrite = await client.callTool({name:'memoir_work_record',arguments:{record:{id:'decision.recovered',kind:'decision',text:'Recovered handoff',source:'Installed MCP recovery test'}}});
  assert.equal(staleWrite.isError,true);
  const resumedWrite = await client.callTool({name:'memoir_work_record',arguments:{record:{id:'decision.recovered',kind:'decision',text:'Recovered handoff',source:'Installed MCP recovery test',expected_recovery:recoveredWork.recovery_id}}});
  assert.notEqual(resumedWrite.isError,true);
  await client.close(); client = null;
  assert.match(cli(['work','view','--help']),/no-open/);
  const { startWorkView } = await import(pathToFileURL(path.join(pkg,'src/work/view.js')));
  viewer = await startWorkView(project);
  const capability = new URLSearchParams(new URL(viewer.url).hash.slice(1)).get('token');
  assert.equal((await fetch(viewer.origin+'/api/state')).status,401);
  const viewState = await (await fetch(viewer.origin+'/api/state',{headers:{Authorization:'Bearer '+capability}})).json();
  assert.equal(viewState.records.find(r=>r.id==='answer.packed').answer,'Local review');
  for (const asset of ['/','/app.js','/style.css']) assert.equal((await fetch(viewer.origin+asset)).status,200);
  await viewer.close(); viewer = null;
  console.log(JSON.stringify({status:'passed',version,artifact:packed.filename,checks:['tarball install','included rollout docs','CLI version','three-client setup','MCP remember','MCP note','restart recall','two encrypted pushes','restore canonical records','restore session','scoped resume','project-only setup','installed work command','executed check receipt','project MCP resume without personal memory','installed view command and assets','authenticated project view','automatic project snapshots','encrypted project export','damaged project recovery','preserved client settings','post-recovery MCP stale-write guard','post-recovery MCP continuation']},null,2));
} finally {
  if (client) await client.close();
  if (viewer) await viewer.close();
  await fs.rm(scratch,{recursive:true,force:true});
}
