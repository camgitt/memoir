#!/usr/bin/env node
// This entry point does not load global configuration or emit telemetry.
import { workCli } from '../src/work/cli.js';
import { workErrorMessage } from '../src/work/errors.js';
try { await workCli(process.argv.slice(2)); }
catch (error) {
  if (error.code === 'commander.helpDisplayed' || error.code === 'commander.help') process.exitCode = 0;
  else { console.error(workErrorMessage(error)); process.exitCode = 1; }
}
