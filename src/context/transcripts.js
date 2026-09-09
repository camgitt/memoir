// One definition of "this .jsonl is an agent transcript, not the user talking."
//
// Claude Code writes subagent transcripts as `agent-<id>.jsonl` inside a
// `subagents/` directory. The FIRST user message in one of those files is the
// orchestrator's prompt ("You are a software architect. Note that ..."), not
// anything a person typed. Treating them as user speech has already produced
// two distinct failures in this codebase:
//
//   1. src/context/capture.js minted pinned "decisions" out of system prompts —
//      three of the author's own were subagent-prompt fragments.
//   2. src/commands/snapshot.js collected them into a handoff summary whose
//      prompt is labelled "User messages (what they asked for)" and POSTed to
//      generativelanguage.googleapis.com, so orchestrator prompts left the
//      machine entirely.
//
// Both were written as `!name.includes('subagent')`, which never matches
// `agent-<id>.jsonl` — the substring is "agent-", not "subagent". capture.js
// was fixed in place; snapshot.js kept the defeated test for three more weeks
// because the predicate was spelled four different ways across three files.
// It is spelled once here now.

/** Per-session side directories that never contain user speech. */
const SIDE_CAR_DIRS = new Set(['subagents', 'workflows', 'tool-results']);

/** True for a directory that holds agent-generated transcripts, not user turns. */
export function isSideCarDir(name) {
  return SIDE_CAR_DIRS.has(name);
}

/**
 * True for a .jsonl file that is an agent transcript rather than a user
 * session. Covers both the real filename (`agent-<id>.jsonl`) and the older
 * `*subagent*` spelling, so a directory walk that reaches one anyway is safe.
 */
export function isAgentTranscript(name) {
  return name.startsWith('agent-') || name.includes('subagent');
}

/** True for a .jsonl file safe to read as a record of what the user asked for. */
export function isUserTranscript(name) {
  return name.endsWith('.jsonl') && !isAgentTranscript(name);
}
