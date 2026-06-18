# Ancestry-Aware Sync & Conflict Resolution — Design

Status: **DRAFT for review** · Owner: FsAgent · Scope: `@rljson/fs-agent`
(+ small enablement in `@rljson/db` / `@rljson/server` and the deployed nodes).

---

## 1. Target behaviour (the requirement)

A Nextcloud-style offline-edit + conflict model:

1. Client is offline, working on file-tree revision **A**.
2. Client edits a file → produces revision **B** (predecessor **A**).
3. Client comes online → the EventHub delivers revision **C** (predecessor **A**)
   that another client produced meanwhile.
4. The client walks backwards from the incoming revision looking for the
   predecessor that is also its own last revision; if unknown it keeps walking.
5. It finds that it has its **own** successor of A (**B**), and B ≠ C
   (incoming, predecessor A) → **conflict**.
6. The conflicting file(s) are **renamed Nextcloud-style**, and a new merge
   revision **D** (predecessor **C**) is produced.
7. **D** is sent; everyone converges on D.

In short: detect that two revisions descend from a common ancestor but diverge,
preserve both sides by renaming the loser, and merge the DAG back into one tip.

---

## 2. TL;DR — most of this already exists

The rljson stack **already implements ancestry, conflict *detection*, and
durability**. The only missing piece is **conflict *resolution*** (the rename +
merge), which `@rljson/rljson` explicitly defers to "upper layers (application
code)" — i.e. the FsAgent. So this is mostly *wiring up existing primitives*
plus one new resolution module, **not** building a sync engine from scratch.

| Capability | Where it lives today | Status |
|---|---|---|
| Predecessor chain (ancestry) | `InsertHistory` rows carry `previous` (predecessor timeIds); written on every `insertTrees` | ✅ exists |
| Predecessor chain on the wire | `ConnectorPayload.seq` (monotonic per client/route) + `.p` (causal predecessor timeIds) | ✅ exists, gated by `SyncConfig` |
| Conflict **detection** | `Db.detectDagBranch(table)` finds ≥2 divergent DAG tips → `Conflict{type:'dagBranch', branches:[tipIds]}`; fired automatically after each insert via `registerConflictObserver` callbacks | ✅ exists |
| Durability / recovery | `gap-fill` (`GapFillRequest`/`Response` on `${route}:gapfill:*`) — a peer detects a `seq` gap and re-requests missing refs | ✅ exists, gated by `SyncConfig` |
| Conflict **resolution** (rename + merge revision) | — | ❌ **missing — this design** |

Key code references:
- `@rljson/db` — `detectDagBranch`, `registerConflictObserver`,
  `_writeInsertHistory` → auto-detect on insert
  (`rljson-db/src/db.ts:1509,1605,1663`).
- `@rljson/rljson` — `sync/conflict.ts` (`Conflict`, `ConflictType='dagBranch'`,
  "detection only — resolution left to upper layers"), `sync/gap-fill.ts`,
  `sync/connector-payload.ts`, `insertHistory/insertHistory.ts`,
  `content/revision.ts` (`predecessor`/`successor`).
- `@rljson/fs-agent` — `FsAgent.syncFromDb` / `processRef`
  (`fs-agent.ts:915`), `FsDbAdapter.storeFsTree` (`fs-db-adapter.ts:44`),
  `restore` + `cleanTarget` (`fs-agent.ts:344`).

---

## 3. Current FsAgent behaviour (and why it's wrong for this model)

`syncFromDb` debounces incoming refs to the **latest**, then `processRef`:
fetch the incoming tree → content-compare for bounce-back → if different,
`restore()` with `cleanTarget` = **overwrite local with incoming**.

Two consequences:
- **On divergence it overwrites** — a client's offline edit (B) is silently
  replaced by C. This is the opposite of the requirement.
- **On a fetch timeout it drops the ref** after retries (no re-queue, no
  reconnect recovery) — the durability bug behind the failing E2E phases
  (`hub-crash`, `disconnect-recovery`, `snapshot-bootstrap`, `concurrency`).
  It does **not** lean on the existing gap-fill mechanism.

The FsAgent also **never registers a conflict observer**, so `detectDagBranch`'s
signal is computed and thrown away.

---

## 4. Design

### 4.1 Foundation — durability (do this first)

Conflict resolution is meaningless if refs are lost. Make incoming sync
eventually-consistent:

- **Enable gap-fill** end-to-end (the `SyncConfig` flags for `seq` + gap-fill —
  see §6) so a client that missed refs during a disruption re-requests them on
  reconnect.
- **Stop silently dropping in `processRef`.** On final failure, instead of
  `_writeSyncError` + drop, **re-queue** the latest known DB head and retry when
  the transport reports connected (Connector reconnect event) — or fall back to
  a periodic **reconcile** that re-fetches the current head and applies it.
- Net effect: after any disruption the client converges on the current head,
  which is the precondition for detecting & resolving conflicts.

### 4.2 Ancestry — record predecessor on every stored FS tree

`insertTrees` already writes an `InsertHistory` row; ensure its `previous`
correctly points at the ref the local edit was based on (the client's last
applied head). This is the `seq`/predecessor machinery — confirm it is enabled
and that `storeFsTree` flows through it. After this, the DAG is correct and
`detectDagBranch` is meaningful for FS trees.

### 4.3 Conflict detection — subscribe

In `syncFromDb`, call `db.registerConflictObserver(route, onConflict)` (and
unregister in the returned disposer). `onConflict(conflict)` fires automatically
whenever an insert creates a second tip (`conflict.branches = [tipA, tipB, …]`).

### 4.4 Conflict resolution — the new module (`fs-conflict-resolver.ts`)

On `onConflict({ branches })` for our route/table:

1. **Resolve tips → trees.** Map each tip `timeId` → root ref
   (`db.getRefOfTimeId`) → fetch each branch's FS tree
   (`_fetchTreeFromDb`). Fetch the **common ancestor** tree (walk `previous`
   from both tips to the nearest shared timeId).
2. **Three-way file-level merge** (ancestor **O**, ours **B**, theirs **C**),
   per relative path:
   | O | B | C | Result |
   |---|---|---|---|
   | – | x | – | take B (we added) |
   | – | – | y | take C (they added) |
   | x | x | x | unchanged |
   | a | b | a | take B (only we changed) |
   | a | a | c | take C (only they changed) |
   | a | b | c, b≠c | **CONFLICT** |
   | a | (del) | c, c≠a | **CONFLICT** (edit/delete) |
   | a | b | (del), b≠a | **CONFLICT** (edit/delete) |
   | a | (del) | (del) | delete |
   Content compared by blobId/hash (mtime ignored), reusing the existing
   `_treesHaveEquivalentContent` / content-map helpers.
3. **Resolve each CONFLICT, Nextcloud-style:** keep the incoming (C) version at
   the original path, and write **our** (B) version beside it renamed
   `‹name› (conflicted copy ‹host› ‹YYYY-MM-DD HHMMSS›)‹.ext›`. (Policy choice —
   see §5. Both copies are preserved; nothing is lost.)
4. **Materialise** the merged set on disk (reuse `restore`, but *targeted* — only
   touch changed/renamed paths; do **not** `cleanTarget`-nuke), then **store**
   the result as a **merge revision D** whose `InsertHistory.previous = [tipB,
   tipC]`. Two parents collapse the fork → single tip → `detectDagBranch`
   returns null thereafter.
5. **Broadcast D** (normal notify). Peers receive D (predecessor C+B), apply it,
   and converge. D is a descendant of every branch, so no new fork.

### 4.5 Loop / bounce-back avoidance

The merge store must not re-trigger a conflict or an echo:
- Track the merge ref in `_lastSentRef` / `_lastSentContentKey` (as
  `processRef` already does post-restore) so the watcher-driven re-scan is a
  content-equivalent no-op.
- Resolution is **deterministic** (same inputs → same merged tree/hash on every
  peer), so two clients resolving the same fork converge on the *same* D rather
  than forking again. Determinism rules: stable path ordering; conflict-copy
  name derived from a **stable** identity (the losing branch's client id +
  timeId), not wall-clock-at-resolution.

---

## 5. Nextcloud naming convention

`document.txt` → `document (conflicted copy NB-2510 2026-06-18 091500).txt`.
- Insert before the final extension; no extension → append.
- Identity + timestamp come from the **losing revision** (client id + InsertHistory
  timestamp), not the resolving machine's clock — so every peer generates the
  identical name (determinism, §4.5).
- Repeated conflicts on an already-conflicted file get a numeric suffix.

Open policy question (§11): which side "wins" the original path — incoming (C)
or local (B)? Nextcloud keeps the **server** copy at the path and renames the
**local** one. Our analogue: keep the branch with the **lower (client id,
timeId)** at the path, rename the other — deterministic and symmetric.

---

## 6. `SyncConfig` flags to enable

The `ConnectorPayload` predecessor/gap-fill fields are opt-in via `SyncConfig`
(`@rljson/server`). For this to work the deployed nodes must enable the flags
that turn on `seq` + causal `p` + gap-fill (and the conflict path). Audit
`SyncConfig` usage in `ds_serverless_client_server` config
(`node-config.ts` / `server-config.ts` / `client-config.ts`) and the
`syncConfig` passed into the Client, and switch them on (lab-defaults).
**Action item:** enumerate the exact flags and defaults before coding.

---

## 7. Edge cases

- **3+ divergent tips** — merge pairwise (lowest-identity first), deterministic.
- **Directory vs file** at the same path — conflict; rename the file copy.
- **Binary files** — same blobId comparison; conflict-copy still applies.
- **Ignored files** (`.~lock.`, `~$`, …) — never produce conflict copies.
- **Rapid re-conflicts** — resolution is idempotent; a second identical fork
  resolves to the same D (no churn).
- **Empty / huge trees, deep nesting** — bounded by the existing fetch/restore
  timeouts; ensure resolution respects `cleanTarget=false`.
- **Long offline** — gap-fill may return many refs; reconcile to the head, then
  resolve once against the final tip.

---

## 8. Compatibility / migration

- Tables predating InsertHistory predecessors: first head has no `previous`;
  treat a missing common ancestor as "empty O" (everything is add/add) — already
  covered by the merge table.
- Backward compatible: `ConnectorPayload` extra fields are optional; peers
  without the flags keep today's overwrite behaviour. Resolution only activates
  where the flags + observer are present, so rollout is incremental.

---

## 9. Testing strategy

- **Unit (`fs-conflict-resolver`)** — pure 3-way merge over synthetic O/B/C
  trees: every row of the §4.4 table, naming determinism, 3-tip merge,
  edit/delete conflicts, ignored-file exclusion. 100 % coverage (house style).
- **FsAgent integration** — two in-process FsAgents on separate folders +
  injected stores: offline-edit-both-sides → exactly one conflict copy on each,
  identical merged tree hash, single tip afterwards.
- **E2E (the deployed suite)** — the currently-failing phases become *positive*
  conflict/durability tests:
  - `disconnect-recovery`: disconnected node edits, peer edits same file →
    after reconnect both versions exist, no data loss.
  - `concurrency`: concurrent divergent writes converge to one tree with a
    conflict copy.
  - `hub-crash` / `snapshot-bootstrap`: durability — the post-event write
    always lands (gap-fill / reconcile).

---

## 10. Staged delivery (independently shippable PRs)

1. **Durability** (`@rljson/fs-agent`): reconcile-on-reconnect + stop dropping;
   enable gap-fill flags. → fixes the 4 failing phases under overwrite semantics.
2. **Ancestry audit** (`@rljson/server`/config): enable `seq`/`p`; verify
   `storeFsTree` records correct predecessors; expose `getRefOfTimeId` use.
3. **Conflict resolver** (`@rljson/fs-agent`): `fs-conflict-resolver.ts` +
   observer wiring + Nextcloud rename + merge revision D. → delivers the model.
4. **Suite update** (`ds_serverless_client_server`): turn the 4 phases into
   conflict/durability assertions.

Each stage is releasable; the model is complete after stage 3.

---

## 11. Resolved decisions (reviewed 2026-06-18)

1. **Path ownership — Nextcloud.** The conflict **winner keeps the original
   path; the loser is renamed** to the conflicted-copy name. To stay
   deterministic across peers (decision 3), "winner" is **not** the
   perspective-dependent "incoming" but a **deterministic order over the two
   branch revisions**: the revision with the greater InsertHistory `timestamp`
   wins the path, tie-broken by `clientId`. This is Nextcloud-style (loser
   renamed, nothing lost) *and* identical on every peer.
2. **Merge runs on CLIENTS only; the hub has no intelligence.** The hub is a
   dumb relay/store — it never resolves. A **client** observes the `dagBranch`,
   merges locally, and broadcasts the deconflicted merge revision **D** (with the
   conflict copy in place). The resolver is gated to **client-role** FsAgents;
   the hub's FsAgent never registers the resolver. (Implication: the hub's own
   folder is not authoritative under conflict; clients own the data. See §4.4.)
3. **Determinism — confirmed.** The conflict-copy name is derived from the
   **losing revision's** `clientId` + InsertHistory `timestamp` (never the
   resolver's wall clock), and the path-winner is the deterministic order in (1).
   So if two clients resolve the same fork concurrently they produce the **same
   content-addressed D** → no re-fork.
4. **Edit/delete — keep the edit.** When one side edits and the other deletes,
   it is a conflict and the **edited copy is kept** (delete loses).
5. **`SyncConfig` flags — approved.** Audit and enable the `seq`/`p`/gap-fill
   (and conflict) flags in the lab node/server config as part of Stage 2 (§6).
