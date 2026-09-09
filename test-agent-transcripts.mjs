#!/usr/bin/env node
// Agent transcripts must never be read as user speech.
//
// Claude Code writes subagent transcripts as `agent-<id>.jsonl` under a
// `subagents/` directory. Their first user message is the orchestrator's
// prompt, not a person. Two paths in this codebase consume session .jsonl
// files, and both used `!name.includes('subagent')` — a test the real
// filename never trips, because the substring is "agent-", not "subagent".
//
// capture.js was fixed in place and minted no more decisions from system
// prompts. snapshot.js kept the defeated test, and its sink is further out:
// the messages are labelled "User messages (what they asked for)" in a
// prompt POSTed to generativelanguage.googleapis.com. So the same bug that
// was cosmetic in one path sent orchestrator prompts off the machine in the
// other. The predicate lives in one module now; this pins its behaviour.

import fs from 'fs-extra';
import path from 'path';
import os from 'os';

// ⚠️  HOME MUST BE SHIMMED BEFORE THE FIRST ./src IMPORT — DO NOT MOVE THIS.
// See the same warning in test-decisions-hidden.mjs for the 2026-07-13
// incident where a ./src import bound paths.session to the real session.json.
const scratchHome = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-transcripts-test-'));
process.env.HOME = scratchHome;
process.env.USERPROFILE = scratchHome; // Windows

const { isSideCarDir, isAgentTranscript, isUserTranscript } =
  await import('./src/context/transcripts.js');

const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', RESET = '\x1b[0m';
let pass = 0, fail = 0;
const assert = (cond, label) => {
  if (cond) { pass++; console.log(`  ${GREEN}PASS${RESET} ${label}`); }
  else { fail++; console.log(`  ${RED}FAIL${RESET} ${label}`); }
};

console.log(`\n${BOLD}agent transcripts are not user speech${RESET}\n`);

// The exact filename the old predicate missed. This is the regression.
const REAL = 'agent-4f2c1b9a-77de-4b31-9f0e-2a6c8d3e1b55.jsonl';
assert(isAgentTranscript(REAL), 'agent-<uuid>.jsonl is recognised as an agent transcript');
assert(isUserTranscript(REAL) === false, 'agent-<uuid>.jsonl is NOT read as user speech');

// Prove the old spelling really was defeated, so nobody reintroduces it.
assert(!REAL.includes('subagent'),
  'the old !includes("subagent") test does not match the real filename');

// The older spelling still has to be refused if a walk reaches one.
assert(isAgentTranscript('subagent-1.jsonl'), 'legacy *subagent* naming still refused');

// Ordinary session transcripts must still be read.
const USER = '9f3a55ab-fd8c-4cb1-bcd7-483a49a82913.jsonl';
assert(isUserTranscript(USER), 'a normal session .jsonl is still read as user speech');
assert(isAgentTranscript(USER) === false, 'a normal session .jsonl is not an agent transcript');

// Non-transcripts are not user speech either.
assert(isUserTranscript('notes.md') === false, 'a non-.jsonl file is not a user transcript');

// Side-car directories.
for (const dir of ['subagents', 'workflows', 'tool-results']) {
  assert(isSideCarDir(dir), `${dir}/ is a side-car directory`);
}
assert(isSideCarDir('projects') === false, 'projects/ is still traversed');

// Both consumers must import the shared predicate rather than respell it.
for (const file of ['src/commands/snapshot.js', 'src/context/capture.js', 'src/adapters/index.js']) {
  const src = await fs.readFile(new URL(file, import.meta.url), 'utf8');
  assert(src.includes("from '../context/transcripts.js'") || src.includes("from './transcripts.js'"),
    `${file} imports the shared predicate`);
  assert(!/!\s*entry\.name\.includes\('subagent'\)/.test(src),
    `${file} no longer spells the defeated test inline`);
}

await fs.remove(scratchHome);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
