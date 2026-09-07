# Project handoff backup and recovery

Memoir protects `.memoir/work.json` automatically. You keep using the same
project folder and branch in Codex and Cursor; no extra command is needed for
each save. The optional browser uses the same protection.

## Check that it is protected

```sh
memoir work doctor
```

The result reports ledger health, whether its current contents have a verified
snapshot, damaged copies and the available snapshot IDs. An unhealthy existing
handoff exits with status 1 so scripts can detect problems. `empty` describes a
project with no saved records and exits 0. This checks local data, not account
security, remote services or the accuracy of stored claims.

Existing handoffs are protected on the first updated `resume` or next write.
You can also create a copy explicitly:

```sh
memoir work backup
```

## Keep a copy outside this project

```sh
memoir work backup --output /path/to/backups/project-handoff.memoir
```

Choose an existing destination folder and a **new filename**. The interactive
terminal asks for a passphrase twice. Use a strong passphrase of at least 12
characters, kept separately in your password manager. Memoir cannot recover it.
An export never overwrites an existing file.

For automation, a secret manager can inject `MEMOIR_WORK_PASSPHRASE` into the
environment. There is no command-line password flag. Do not put that value in
shell history, project files, a handoff record, or a conversation with an agent.
The older `MEMOIR_PASSPHRASE` setting is separate and is not changed.

The encrypted file includes **all branches and complete history** of this
project ledger, including retracted records and check receipts. It excludes
personal memory, transcripts, raw command output, client settings, other files
inside `.memoir/`, and recovery quarantine. AES-256-GCM with the existing Memoir
scrypt passphrase derivation protects the export; import authenticates it before
parsing. Secret screening remains heuristic. Review project records before
deliberately sharing an export with anyone else.

Store the export on a separate backed-up device or destination you control.
Copies inside `.memoir/` cannot protect against loss of the entire folder or
disk. Git commits, GitHub pushes and the older `memoir push` command do **not**
transport this ledger. To move to another machine, transfer the encrypted file,
recover it there, open the matching branch and run `memoir work setup` there.
Changed files and runtime still cause targeted check warnings.

## Recover a damaged, missing or mistaken handoff

Start with a preview. It does not replace the current ledger:

```sh
memoir work recover
```

This selects the newest valid local copy. Review its revision, branch list and
record counts. To choose another copy, pass an ID returned by `doctor`:

```sh
memoir work recover SNAPSHOT_ID
```

Apply the exact reviewed source and fingerprint:

```sh
memoir work recover SNAPSHOT_ID --apply --expect FINGERPRINT_FROM_PREVIEW
```

For an encrypted export, use its filename in both steps:

```sh
memoir work recover --from /path/to/backups/project-handoff.memoir
memoir work recover --from /path/to/backups/project-handoff.memoir --apply --expect FINGERPRINT_FROM_PREVIEW
memoir work resume
memoir work doctor
```

Recovery replaces the **whole project ledger**, across all branches, rather
than merging selected records. Review an imported backup in an empty recovery
folder first if you need to inspect its contents. The fingerprint binds the
preview to the destination folder, exact current file and source file. A
concurrent save, changed export, or different target requires a fresh preview.
Wrong keys, tampering, unsupported formats, invalid history, detected secrets
and unsafe paths are rejected before replacement.

The original bytes are preserved under `.memoir/work-quarantine/`, including a
damaged original. Quarantine is private local data and is never exported by this
command. Do not publish it; malformed originals might contain secrets. If local
quarantine cannot be written, recovery stops. A missing ledger with surviving
snapshots also stops normal writes instead of silently starting over.

After recovery, **resume in every tool before saving again**. The handoff
returns a `recovery_id`; record and retract calls must pass it as
`expected_recovery` in addition to the existing revision guard. The browser
handles this itself: stale drafts remain available, and reviewing the restored
version allows a deliberate correction. CLI retraction takes `--recovery ID`.
Checks that were still running during recovery cannot overwrite restored
evidence. New checks capture the current generation automatically.

## Storage, failure handling and upgrades

- Before acknowledging a save, Memoir writes verified-content snapshots of the
  previous and proposed states, flushes file contents and atomically replaces
  the ledger. An interrupted save can leave a proposed snapshot that was not
  acknowledged. The recovery preview says so; it is never restored silently.
- Normal retention keeps the newest 20 snapshots, plus at most two protected
  boundary copies. Each contains complete history. Pruning happens only after
  a successful write; a cleanup problem never makes a committed write look
  like a failed save. `doctor` reports damaged copies or excess retention.
- Files are created owner-readable/writable and directories owner-only on
  POSIX. Local ledgers, snapshots and quarantine are plaintext. Directory
  flushes run on POSIX; Windows uses flushed files and atomic replacement but
  cannot guarantee directory power-loss persistence through Node. Filesystem,
  hardware and same-user compromise remain outside this protection.
- The ledger limit remains 2 MiB. Reaching it refuses additional writes without
  dropping history. Keep an encrypted export and start a separate project
  handoff when the working ledger is full; automatic compaction is not provided.
- Upgrade all connected clients before recovery. Ordinary version-1 ledgers
  remain readable; a recovered ledger adds a recovery generation. Older Memoir
  versions reject that field rather than safely participating. Keep a
  pre-upgrade export if you need a downgrade. Restart existing MCP connections
  after upgrading so they load the current server; preserve their approvals.
- A busy lock does not justify deleting it while another process is running.
  Retry once that operation ends. A leftover `.reaper` lock after a crash needs
  local inspection with all Memoir writers stopped; this release does not
  provide a general filesystem lock repair tool.

Recovery preserves local observations; it does not authenticate their authors
or certify their conclusions. Existing check-input comparisons still apply.
External settings need fresh verification independently of any backup.
