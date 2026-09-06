#!/usr/bin/env node
// Deliberately exposes only the connected project's continuation records.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { workRoot, recordSchema, checkSchema, recordWork, retractWork, refreshWork, formatWork } from './store.js';
import { workErrorMessage } from './errors.js';

const project = await workRoot(process.env.MEMOIR_PROJECT_ROOT || process.cwd());
const server = new McpServer({ name: 'memoir-work', version: '1.0.0' });
const respond = handler => async args => {
  try {
    const value = await handler(args);
    const view = await refreshWork(project);
    return { content: [{ type: 'text', text: value ? JSON.stringify(value) : formatWork(view) }] };
  } catch (error) {
    // Never echo rejected input, which might contain credentials.
    return { isError: true, content: [{ type: 'text', text: workErrorMessage(error) }] };
  }
};
server.tool('memoir_work_resume', 'Read this project and branch: answered questions, decisions, next actions and checks with current input comparisons. Call before asking repeated questions or rerunning saved checks.', {}, respond(async () => null));
server.tool('memoir_work_record', 'Save a project-only goal, answer, decision or next action. Never save personal preferences or secrets. Read first; corrections require the current expected_revision. Source must identify the actual user statement or project evidence. This cannot claim a test passed.', { record: recordSchema }, respond(async ({ record }) => recordWork(project, record)));
// An MCP server runs with its own host privileges, not necessarily the coding
// client's terminal sandbox. Never turn this memory connection into a shell.
// Keep the old tool name to give existing clients a safe migration response.
server.tool('memoir_work_check', 'Command execution is disabled over MCP. Run memoir work check through the client’s normal terminal permission/sandbox route to capture execution evidence.', { check: checkSchema }, async () => ({ isError: true, content: [{ type: 'text', text: 'MCP command execution is disabled. Use the memoir work check CLI documented in project AGENTS.md through your normal terminal permissions. This memory connection does not grant shell access.' }] }));
server.tool('memoir_work_retract', 'Remove a mistaken record from the current handoff; its history remains locally for correction. Read its current revision first.', { id: z.string(), category: z.enum(['record', 'check']).default('record'), expected_revision: z.number().int() }, respond(async input => retractWork(project, input)));
await server.connect(new StdioServerTransport());
