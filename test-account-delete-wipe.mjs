#!/usr/bin/env node
// account-delete wipes `${uid}/` by listing recursively and removing in
// batches of 1000. Prefix DELETE is not a folder delete. No live Storage.
import fs from 'fs-extra';

const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', CYAN = '\x1b[36m', RESET = '\x1b[0m';
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ${GREEN}PASS${RESET} ${msg}`); }
  else { fail++; console.log(`  ${RED}FAIL${RESET} ${msg}`); }
}

const uid = '11111111-1111-4111-8111-111111111111';
const {
  STORAGE_BUCKET,
  STORAGE_LIST_LIMIT,
  STORAGE_REMOVE_LIMIT,
  userStoragePrefix,
  wipeUserStorage,
  deleteCallerAccount,
  listAllObjectPaths,
} = await import('./supabase/functions/account-delete/logic.js');

function file(name, id) {
  return { name, id: id ?? `id-${name}` };
}
function folder(name) {
  return { name, id: null };
}

function listerFromTree(tree) {
  const calls = [];
  const listFolder = async (folderPath, { limit, offset } = {}) => {
    calls.push({ folder: folderPath, limit, offset });
    const entries = tree[folderPath] || [];
    const start = offset || 0;
    const size = limit || STORAGE_LIST_LIMIT;
    return { data: entries.slice(start, start + size), error: null };
  };
  return { listFolder, calls };
}

console.log(`\n${BOLD}${CYAN}account-delete storage wipe (list + batch remove)${RESET}\n`);

assert(STORAGE_BUCKET === 'memoir-backups', 'wipe targets memoir-backups');
assert(STORAGE_LIST_LIMIT === 1000 && STORAGE_REMOVE_LIMIT === 1000, 'list/remove pages are 1000');
assert(userStoragePrefix(uid) === `${uid}/`, 'prefix is uid/');

{
  const rootFiles = Array.from({ length: 1005 }, (_, i) => file(`obj-${i}.gz`));
  const tree = { [uid]: rootFiles };
  const { listFolder, calls } = listerFromTree(tree);
  const { paths, error } = await listAllObjectPaths({ listFolder, root: uid });
  assert(!error, '>1000 files: list does not error');
  assert(paths.length === 1005, '>1000 files: all objects collected');
  assert(paths[0] === `${uid}/obj-0.gz` && paths[1004] === `${uid}/obj-1004.gz`,
    '>1000 files: paths are rooted at uid');
  const rootPages = calls.filter((c) => c.folder === uid);
  assert(rootPages.length >= 2, '>1000 files: list is paged past the 1000 limit');
  assert(rootPages[0].offset === 0 && rootPages[1].offset === 1000,
    '>1000 files: second page uses offset 1000');
}

{
  const tree = {
    [uid]: [file('root.gz'), folder('shares'), folder('backups')],
    [`${uid}/shares`]: [file('a.gz'), folder('nested')],
    [`${uid}/shares/nested`]: [file('deep.gz')],
    [`${uid}/backups`]: [file('b.gz')],
  };
  const { listFolder } = listerFromTree(tree);
  const { paths } = await listAllObjectPaths({ listFolder, root: uid });
  assert(paths.sort().join(',') === [
    `${uid}/backups/b.gz`,
    `${uid}/root.gz`,
    `${uid}/shares/a.gz`,
    `${uid}/shares/nested/deep.gz`,
  ].join(','), 'nested folders: every file under uid is listed');
}

{
  const tree = {
    [uid]: [file('root.gz'), folder('shares')],
    [`${uid}/shares`]: [file('a.gz')],
  };
  const { listFolder } = listerFromTree(tree);
  const removedCalls = [];
  const listedAfterDelete = { [uid]: [] };
  const listFolderThenEmpty = async (folderPath, opts) => {
    if (removedCalls.length) return { data: listedAfterDelete[folderPath] || [], error: null };
    return listFolder(folderPath, opts);
  };
  const wipe = await wipeUserStorage({
    prefix: `${uid}/`,
    listFolder: listFolderThenEmpty,
    removeObjects: async (paths) => {
      removedCalls.push(paths.slice());
      return { removed: paths };
    },
  });
  assert(wipe.ok === true, 'nested folders: wipe succeeds');
  assert(removedCalls.length === 1, 'nested folders: one remove batch');
  assert(removedCalls[0].sort().join(',') === [`${uid}/root.gz`, `${uid}/shares/a.gz`].sort().join(','),
    'nested folders: remove is called with full object paths, not folder names');
}

{
  const files = Array.from({ length: 1005 }, (_, i) => file(`obj-${i}.gz`));
  const tree = { [uid]: files };
  const { listFolder } = listerFromTree(tree);
  const removedCalls = [];
  const listFolderThenEmpty = async (folderPath, opts) => {
    if (removedCalls.length) return { data: [], error: null };
    return listFolder(folderPath, opts);
  };
  const wipe = await wipeUserStorage({
    prefix: `${uid}/`,
    listFolder: listFolderThenEmpty,
    removeObjects: async (paths) => {
      removedCalls.push(paths.slice());
      return { removed: paths };
    },
  });
  assert(wipe.ok === true && wipe.deleted === 1005, '>1000 files: wipe reports every object removed');
  assert(removedCalls.length === 2, '>1000 files: remove is split into two batches');
  assert(removedCalls[0].length === 1000 && removedCalls[1].length === 5,
    '>1000 files: first batch is 1000, remainder is 5');
}

{
  const tree = { [uid]: [file('a.gz'), file('b.gz')] };
  const { listFolder } = listerFromTree(tree);
  const wipe = await wipeUserStorage({
    prefix: `${uid}/`,
    listFolder,
    removeObjects: async (paths) => ({ removed: paths.slice(0, 1) }),
  });
  assert(wipe.ok === false && wipe.error === 'partial_remove',
    'partial remove: wipe fails when fewer objects are removed than requested');
  assert(wipe.stage === 'remove' && wipe.requested === 2 && wipe.removed === 1,
    'partial remove: records requested vs removed counts');
}

{
  let deleteCalls = 0;
  const result = await deleteCallerAccount({
    userId: uid,
    subscriptions: [],
    listFolder: async () => ({ data: [file('orphan.gz')], error: null }),
    removeObjects: async (paths) => ({ removed: paths.slice(0, 0) }),
    deleteUser: async () => { deleteCalls += 1; return {}; },
  });
  assert(result.status === 502 && result.body.error === 'storage_wipe_failed',
    'partial failure: account-delete returns 502');
  assert(deleteCalls === 0, 'partial failure: deleteUser is never called after a failed wipe');
}

{
  let deleteCalls = 0;
  let listCalls = 0;
  const result = await deleteCallerAccount({
    userId: uid,
    subscriptions: [],
    listFolder: async () => { listCalls += 1; return { data: null, error: { message: 'list failed' } }; },
    removeObjects: async () => ({ removed: [] }),
    deleteUser: async () => { deleteCalls += 1; return {}; },
  });
  assert(result.status === 502, 'list error: 502');
  assert(listCalls >= 1 && deleteCalls === 0, 'list error: deleteUser is never called');
}

{
  let deleteCalls = 0;
  let removeCalls = 0;
  const result = await deleteCallerAccount({
    userId: uid,
    subscriptions: [{ status: 'pro' }],
    listFolder: async () => ({ data: [file('x.gz')], error: null }),
    removeObjects: async () => { removeCalls += 1; return { removed: [] }; },
    deleteUser: async () => { deleteCalls += 1; return {}; },
  });
  assert(result.status === 409 && result.body.error === 'subscription_active',
    'pro: 409 subscription_active');
  assert(removeCalls === 0 && deleteCalls === 0, 'pro: neither wipe nor deleteUser runs');
}

{
  let deleteCalls = 0;
  const empty = async () => ({ data: [], error: null });
  const result = await deleteCallerAccount({
    userId: uid,
    subscriptions: [],
    listFolder: empty,
    removeObjects: async (paths) => { throw new Error(`unexpected remove ${paths}`); },
    deleteUser: async (id) => { deleteCalls += 1; assert(id === uid, 'deleteUser receives JWT subject'); return {}; },
  });
  assert(result.status === 200 && result.body.deleted === true, 'empty prefix: deleteUser runs after empty re-list');
  assert(deleteCalls === 1, 'empty prefix: deleteUser called once');
}

{
  const fn = await fs.readFile(new URL('./supabase/functions/account-delete/index.ts', import.meta.url), 'utf8');
  assert(/deleteCallerAccount/.test(fn), 'edge function delegates to deleteCallerAccount');
  assert(/storage\.from\(STORAGE_BUCKET\)\.list/.test(fn), 'edge function lists via the Storage API');
  assert(/storage\.from\(STORAGE_BUCKET\)\.remove/.test(fn), 'edge function removes via the Storage API');
  assert(!/prefixes:\s*\[prefix\]/.test(fn) && !/JSON\.stringify\(\{\s*prefixes/.test(fn),
    'edge function does not DELETE by prefixes (that matches object names, not folders)');
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
