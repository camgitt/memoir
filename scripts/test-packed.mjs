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
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'),
};
for (const key of ['SystemRoot','TEMP','TMP']) if (process.env[key]) env[key] = process.env[key];
const run = (command, args, cwd = repository) => execFileSync(command, args, { cwd, env, encoding: 'utf8', timeout: 180000, stdio: ['ignore','pipe','pipe'] });
let client;
try {
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(install, { recursive: true });
  const packed = JSON.parse(run('npm', ['pack','--ignore-scripts','--json','--pack-destination',scratch]))[0];
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
  console.log(JSON.stringify({status:'passed',version,artifact:packed.filename,checks:['tarball install','included rollout docs','CLI version','three-client setup','MCP remember','MCP note','restart recall','two encrypted pushes','restore canonical records','restore session','scoped resume']},null,2));
} finally {
  if (client) await client.close();
  await fs.rm(scratch,{recursive:true,force:true});
}
