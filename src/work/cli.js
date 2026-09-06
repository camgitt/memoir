import { Command } from 'commander';
import { recordWork, runWorkCheck, retractWork, refreshWork, formatWork } from './store.js';
import { setupWork } from './setup.js';
import { readSafeFile } from '../security/files.js';

export async function workCli(argv) {
  const program = new Command('memoir work').description('Local project continuity for Codex and Cursor')
    .option('--project <path>', 'Project directory', process.env.MEMOIR_PROJECT_ROOT || process.cwd());
  const project = () => program.opts().project;
  program.command('setup').option('--tools <names>', 'codex,cursor', 'codex,cursor').action(async options => {
    console.log(JSON.stringify(await setupWork(project(), { tools: options.tools.split(',') }), null, 2));
  });
  program.command('resume').option('--json', 'Structured context').action(async options => {
    const view = await refreshWork(project());
    console.log(options.json ? JSON.stringify(view, null, 2) : formatWork(view));
  });
  program.command('view').description('Review and correct project memory in a local browser')
    .option('--no-open', 'Print the local link without opening a browser').option('--port <number>', 'Local port; 0 chooses an available port', '0').action(async options => {
      const { startWorkView } = await import('./view.js');
      const view = await startWorkView(project(), { port: Number(options.port) });
      console.log(`Memoir project view: ${view.url}\nOnly this computer. Keep this terminal open; press Ctrl+C to stop.`);
      if (options.open) {
        const { spawn } = await import('node:child_process');
        const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
        const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', view.url] : [view.url];
        const child = spawn(command, args, { stdio:'ignore', shell:false });
        child.on('error', () => console.error('Open the local link above in your browser.'));
      }
      const stop = async () => { await view.close(); process.exitCode = 0; };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    });
  program.command('record').option('--json <record>', 'Project record JSON').option('--file <path>', 'Project-relative JSON file; - reads stdin').action(async options => {
    if (Boolean(options.json) === Boolean(options.file)) throw new Error('Provide exactly one of --json or --file.');
    let raw = options.json;
    if (options.file === '-') {
      const chunks = []; let bytes = 0;
      for await (const chunk of process.stdin) {
        bytes += chunk.length;
        if (bytes > 16384) throw new Error('Project record input exceeds 16 KiB. Nothing was saved.');
        chunks.push(chunk);
      }
      raw = Buffer.concat(chunks).toString();
    }
    else if (options.file) raw = (await readSafeFile(project(), options.file, { maxBytes: 16384 })).toString();
    if (Buffer.byteLength(raw) > 16384) throw new Error('Project record input exceeds 16 KiB. Nothing was saved.');
    const record = await recordWork(project(), JSON.parse(raw));
    await refreshWork(project());
    console.log(JSON.stringify(record, null, 2));
  });
  program.command('check <id> [argv...]').requiredOption('--title <text>', 'What the check proves').requiredOption('--files <paths...>', 'All relevant source/test inputs')
    .option('--environment <name>', 'local or external', 'local').option('--timeout <ms>', 'Time limit', '30000').action(async (id, command, options) => {
      const result = await runWorkCheck(project(), { id, title: options.title, files: options.files, command, environment: options.environment, timeout_ms: Number(options.timeout) });
      await refreshWork(project());
      console.log(JSON.stringify(result, null, 2));
      if (result.exit_code !== 0 || result.timed_out || !result.inputs_stable) process.exitCode = 1;
    });
  program.command('retract <id>').requiredOption('--revision <number>', 'Current record revision').option('--category <name>', 'record or check', 'record').action(async (id, options) => {
    const result = await retractWork(project(), { id, expected_revision: Number(options.revision), category: options.category });
    await refreshWork(project());
    console.log(JSON.stringify(result));
  });
  program.exitOverride();
  await program.parseAsync(argv, { from: 'user' });
}
