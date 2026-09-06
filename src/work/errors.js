// Parser and filesystem messages can contain snippets of damaged secret files.
// Only our fixed domain errors may pass through to the client.
export function workErrorMessage(error) {
  if (error instanceof SyntaxError) return 'Invalid project handoff JSON. Original file was preserved; contents were not returned.';
  if (error?.name === 'ZodError' || error instanceof TypeError) return 'Invalid project record or evidence. Check the schema; original data was preserved.';
  if (error?.code && error.code !== 'ELOCKED') return 'Project operation failed. Check file access and command arguments locally; file contents were not returned.';
  return error?.message || 'Project operation failed.';
}
