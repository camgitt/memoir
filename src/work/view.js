// A bounded local editor, never a shell or general filesystem endpoint.
import http from 'node:http';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { z } from 'zod';
import { workRoot, reviewWork, recordWork, retractWork, restoreWork } from './store.js';
import { workErrorMessage } from './errors.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const actionSchema = z.object({
  action: z.enum(['save', 'remove', 'restore']),
  branch: z.string().max(1024).nullable(),
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/),
  expected_revision: z.number().int().nonnegative(),
  category: z.enum(['record', 'check']).default('record'),
  fields: z.object({ kind: z.enum(['goal', 'answer', 'decision', 'next']), text: z.string().min(1).max(2000), answer: z.string().max(2000).optional(), why: z.string().max(2000).optional(), status: z.enum(['open', 'done']).default('open') }).strict().optional(),
}).strict();

const headers = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin', 'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'",
};
function reply(res, status, value, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { ...headers, 'Content-Type': type });
  res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
}
async function body(req) {
  const parts = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 16384) throw new Error('Request is too large. Nothing was saved.');
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString());
}

export async function startWorkView(project, { port = 0 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Choose a port between 0 and 65535.');
  const root = await workRoot(project);
  await reviewWork(root); // Refuse damaged data before announcing a working view.
  const token = crypto.randomBytes(32).toString('base64url');
  const expectedAuth = Buffer.from('Bearer ' + token);
  let origin;
  const server = http.createServer(async (req, res) => {
    try {
      // Reject alternate Host names (including DNS rebinding) and cross-site
      // browser requests. No CORS permission is granted, including preflight.
      if (req.headers.host !== new URL(origin).host) return reply(res, 403, { error: 'This view only accepts its local address.' });
      if (req.headers.origin && req.headers.origin !== origin || req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return reply(res, 403, { error: 'Open the local Memoir view directly.' });
      const url = new URL(req.url, origin);
      const asset = assets.get(url.pathname);
      if (req.method === 'GET' && asset && !url.search) return reply(res, 200, await fs.readFile(new URL('./ui/' + asset[0], import.meta.url)), asset[1]);
      if (!url.pathname.startsWith('/api/')) return reply(res, 404, { error: 'Not found.' });
      const auth = Buffer.from(req.headers.authorization || '');
      if (auth.length !== expectedAuth.length || !crypto.timingSafeEqual(auth, expectedAuth)) return reply(res, 401, { error: 'Reopen the view with its local link.' });
      if (req.method === 'GET' && url.pathname === '/api/state' && !url.search) return reply(res, 200, await reviewWork(root));
      if (req.method !== 'POST' || url.pathname !== '/api/action' || url.search) return reply(res, 405, { error: 'This action is unavailable.' });
      if (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') return reply(res, 403, { error: 'Save changes from the local view.' });
      const input = actionSchema.parse(await body(req));
      const guard = { expectedBranch: input.branch };
      if (input.action === 'save') {
        if (input.category !== 'record' || !input.fields) return reply(res, 400, { error: 'Only project records can be edited.' });
        const { answer, why, ...fields } = input.fields;
        await recordWork(root, { ...fields, ...(answer ? { answer } : {}), ...(why ? { why } : {}), id: input.id, expected_revision: input.expected_revision, scope: 'project', source: 'Saved in the local project view; previous versions remain in history.' }, guard);
      } else if (input.action === 'remove') {
        await retractWork(root, input, guard);
      } else {
        if (input.category !== 'record') return reply(res, 400, { error: 'Run a new authorized check to replace a removed receipt.' });
        await restoreWork(root, input, guard);
      }
      return reply(res, 200, await reviewWork(root));
    } catch (error) {
      const message = workErrorMessage(error);
      const conflict = /branch changed|Record changed|Record was removed|expected revision|before retracting/.test(message);
      if (!res.headersSent && !res.destroyed) reply(res, 409, conflict
        ? { error: 'Another session changed this item or branch. Review the latest version before saving. Your draft has been kept.', code: 'refresh_required' }
        : { error: message });
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.keepAliveTimeout = 1000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { origin = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
  return { server, origin, url: `${origin}/#token=${token}`, close: () => new Promise(resolve => { server.close(resolve); server.closeIdleConnections?.(); }) };
}
