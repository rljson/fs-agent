# CLAUDE.md — @rljson/fs-agent

Synchronizes filesystem changes with RLJSON databases using tree structures and content-addressed blob storage. Depends on all lower layers.

## Tests

The heap-intensive tests run with
`cross-env NODE_OPTIONS=--max-old-space-size=8192`.

## The sync — rules

- **The chain is the only order.** Never compare two machines' clocks. A
  `timeId` breaks a tie between two entries at the same distance in
  `lastEditOf`, and nothing else; two concurrent versions are ordered by the
  hub's stamp (`README.architecture.md` → *The stamp*).
- **A deletion is applied only from a `behind` head** — one that descends from
  this node's own. Anywhere else an absence reaches the folder only through
  `merge3`, against the base. Never prune on any other evidence.
- **Author local work before judging any head** (`receive`'s first step), so a
  head that never saw that work cannot overwrite it.
- **Author from a pass that began after the agent's own last write**
  (`_passAfterOwnWrites`): a fresh scan after a receive or a join, the
  watcher's last pass otherwise. A pass that overlapped an apply announces a
  revert (F9); scanning afresh on every change hashed a stalled copy truncated
  two to five times as often. The no-laundering spec pins both halves.
- **A receiver adopts and never authors.** A merge entry is derived from both
  heads; what a cut-short apply wrote is recorded in `_partiallyApplied`, not
  claimed.
- **C3 decides only with both stamps known.** Otherwise the merge defers, the
  node re-announces its own head with backoff (`STAMP_ASK_*`), and a second
  wait is signalled. Every hub in a test harness is configured with `stamp`, as
  production's must be.
- **Guards at both ends.** The sender does not author a mass disappearance its
  watcher did not see; the receiver keeps what an apply would lose, adopts the
  head anyway and authors the kept files again.
- **`heals-after-forced-divergence` must stay green** on the state beacon and on
  the bootstrap heartbeat.
- **`stateBeaconEvent` comes from `@rljson/db`.** Never spell it out here.

<!-- helix:claude_md:start -->

# gg workflow

This repo is developed ticket by ticket with the `gg` CLI. Follow the
development guide, it tells you when to ask the user and which command
comes next:

@doc/guides/for-ai/ai-dev-guide.md

The steps are also available as skills: `/gg-ticket`, `/gg-commit`,
`/gg-push`, `/gg-review`, `/gg-publish`, `/gg-cleanup`. `/gg` lists them
and says which one comes next.

# rljson additions to the gg workflow

- **Pull requests:** CI on a pull request checks that every commit went
  through gg's local checks (`gg one did commit`). The full tests run on
  `main` after the merge: watch them after every publish.

<!-- helix:claude_md:end -->
