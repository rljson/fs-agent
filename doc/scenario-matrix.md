# The scenario matrix

Every way a folder and a history can disagree, what the agent must do about it,
and whether a test proves it.

**Why this document exists.** The edit chain changed what the agent is allowed
to conclude: the filesystem is an **event source only**, and every question is
answered against the chain and the trees it names. That rule is easy to state
and easy to violate in one branch, so the scenarios it has to answer are
written down here in full rather than discovered one field report at a time.

**What counts as covered.** Three tiers, and only the first two prove a
scenario:

| tier | what it is | where |
| --- | --- | --- |
| **mesh** | real `Server`, real sockets (`createSocketPair`), real watchers, real files, 2–4 nodes, cuts and heals | `test/mesh/*.spec.ts` |
| **client–server** | two or three clients, a real hub, `SocketMock` **and** real socket.io | `test/client-server/*.spec.ts` |
| decision | a pure function, no filesystem, no clock | `fs-plan-join`, `fs-collect-removals`, `fs-classify`, `fs-plan-removals`, `fs-conflict-resolver` |

A decision-tier test proves the RULE. It does not prove the rule is reached, so
a row covered only at that tier is marked **partial**.

---

## 1. Local filesystem operations

What a user or a program can do to a folder, and what the agent must make of
it. The event comes from the watcher; the meaning comes from the chain.

| # | operation | what the chain must say | expected result | covered |
| --- | --- | --- | --- | --- |
| L1 | create a file | an edit claiming that path | reaches every node | mesh F6, c/s *propagate a new file* |
| L2 | modify a file | an edit claiming that path | newest content everywhere | c/s *propagate file content changes* |
| L3 | delete a file | an edit stating the removal | gone everywhere, stays gone | mesh A2, T2, T4, c/s *propagate file deletions* |
| L4 | create a directory with files | edits claiming the paths | structure reaches every node | c/s *new directory with files*, *deeply nested* |
| L5 | delete a directory | removals for every path **and the directory** | directory gone, not just its files | mesh F1, c/s *directory deletion*, field-repro §1 |
| L6 | rename a file | removal + claim, same blob | not a mass deletion; one copy survives | c/s *file rename*, wiped-and-reverted *one rename* |
| L7 | rename a directory | removals + claims, blobs unchanged | not refused as a mass deletion | **mesh-matrix L7** ✓, fs-rename-folder ×2 |
| L8 | move a file between directories | removal + claim, same blob | moved, never duplicated or lost | **mesh-matrix L8** ✓ |
| L9 | file → directory at one path | removal then claim | type change applied, restore not aborted | fs-filetype-changes *file → directory* |
| L10 | directory → file at one path | removals then claim | type change applied | fs-filetype-changes *empty directory → file*, *WITH CONTENTS* |
| L11 | atomic save (temp + rename over) | one edit for the final bytes | final content converges, no temp residue | editor-patterns *an atomic save* |
| L12 | lock file appears and disappears | edits for a short-lived path | no residue anywhere | editor-patterns *an Office lock file* |
| L13 | partial copy still being written | **no edit until it settles** | a truncated file is never announced | fs-slow-copy (decision + single node) — **partial** |
| L14 | touch without changing bytes | **no edit at all** | no traffic, no deletion scare | wiped-and-reverted *touching a file* |
| L15 | create, delete, create again at one path | claim, removal, claim — in order | the second creation reaches every node | editor-patterns *created, deleted and created again* |
| L16 | 100 of 400 files deleted at once | 100 removals | all complete everywhere | mesh F7 |
| L17 | an unwritable / impossible path | the path is skipped, never retried | the rest of the tree still applies | mesh F8, fs-impossible-filename |
| L18 | a locked file that cannot be read | no claim for that path | the rest still syncs; no false deletion | **none at mesh tier** (single-node only) |
| L19 | symlink | the same statement on every platform | identical on both machines; no escape | fs-filetype-changes ×3 |
| L20 | a multi-megabyte file, then its deletion | claim then removal | crosses, and leaves no residue | mesh F9 |

---

## 2. Incoming edits, and how they meet local state

The receiver's side. `classify` answers how the two histories stand; the
folder's bytes never answer it.

| # | incoming | local state | expected result | covered |
| --- | --- | --- | --- | --- |
| I1 | a state that descends from ours (`behind`) | unchanged since | fast-forward | mesh T5, c/s linear propagation |
| I2 | a state we descend from (`ahead`) | we have moved on | **ignored** — never applied | stale-reconnect *ignores a sender that descends from a state this node has left* |
| I3 | the same state we are in | identical bytes | nothing; agree on ONE entry | no-laundering *never emits a ref it received* |
| I4 | a fork (both sides have work, different files) | our own additions | **union** — both sides kept | mesh A1, A3, F2, F3, T1, T3 |
| I5 | a fork on the SAME file | our own edit to it | one winner, loser kept as a conflict copy, conflict reported | mesh F5, F10, c/s *resolves a real offline divergent edit* |
| I6 | a removal we have never seen | we still hold the file | deleted, and tombstoned | mesh A2, c/s *delivers a deletion a peer never received* |
| I7 | a removal for a path we have since re-created | our re-creation is newer | **kept** — the removal is stale | **mesh-matrix I7** ✓, fs-plan-removals |
| I8 | a tree lacking a path, with no removal stated | we hold the path | **nothing deleted** — absence is not a deletion | stale-reconnect *applies a ref with NO ancestry additively* |
| I9 | an ancestry walk that cannot complete | we hold more | nothing deleted; retry on the next announcement | fs-collect-removals *concludes NOTHING* (decision) — **partial** |
| I10 | a state far sparser than ours | we hold the full folder | nothing deleted; **we answer** so the sender catches up | **mesh-matrix I10** ✓, mass-delete-guard ×4 |
| I11 | an empty tree | we hold a full folder | nothing deleted; we answer | mass-delete-guard *answers an empty tree* — **partial** |
| I12 | our own older ref echoed back | we are newer | ignored as a rollback | stale-reconnect, catch-up cost (**open defect**, see §5) |
| I13 | a peer re-creating a path we tombstoned | tombstone set by that peer's own earlier delete | tombstone **lifted**, file written | editor-patterns *created, deleted and created again* |
| I14 | a blob that cannot be fetched | the rest of the tree is fetchable | the rest applies; we stay quiet about a state we do not hold | no-laundering *stays quiet when the apply left it behind* |
| I15 | a peer on the OLD wire format | we are on the new one | converges; ancestry still carried | mesh-mixed ×3 |

---

## 3. Joining a network

The case the chain exists for, and the one that used to be decided by whatever
the folder happened to hold. `planJoin` is the decision; §4 is what is still
missing to reach it.

| # | chain | folder | action | result | covered |
| --- | --- | --- | --- | --- | --- |
| J1 | empty | empty | request the head, apply it, **then** accept fs events | folder filled from the network | mesh T7 (populated peer), *handle both folders starting empty* — **partial: no head request** |
| J2 | empty | non-empty, no head anywhere | this folder is the **origin** | its contents become the first state | fs-plan-join *leaves an origin alone* — **partial** |
| J3 | empty | non-empty, head exists, folder ⊂ head | write what is missing | folder completed | fs-plan-join *writes what the head has* — **partial** |
| J4 | empty | non-empty, a path unknown to the history | **announce** it — new work | the node keeps its own work | fs-plan-join *announces a local file the history has never mentioned* — **partial** |
| J5 | empty | non-empty, a path the history REMOVED | **recover**: rename aside, say nothing | no resurrection, nothing destroyed | fs-plan-join *recovers a local file the history DELETED* — **partial** |
| J6 | empty | non-empty, a path live on both sides, different bytes | head's bytes win, local kept as a conflict copy | no silent overwrite of local work | fs-plan-join *live on both sides* — **partial** |
| J7 | empty | non-empty, head exists and is EMPTY | emptiness is a FACT; judge each local path as J4/J5 | an emptied network stays joinable | fs-plan-join *EMPTY head as a fact* — **partial** |
| J8 | present | agrees with its head | ordinary operation | — | every mesh test |
| J9 | present | differs from its head (crash, or edited while down) | the chain wins on what it STATES; the rest are new local events | neither loss nor resurrection | **mesh-matrix J9 ×2** ✓ — found a real defect, see §6 |
| J10 | present | folder WIPED | do not push emptiness; be refilled | fleet intact, node refilled | wiped-and-reverted *does not empty the fleet* ✓; **refill is an open skip** |
| J11 | present | folder REVERTED to an older copy | the chain's removals win over the old copy | fleet not dragged back | **open skip** — *a node reverted to an older copy* |

---

## 4. What is missing, in priority order

1. **Nothing asks the hub for a head.** `classify` and `collectRemovals` read
   the LOCAL database and degrade to `incomplete`; neither requests the rows it
   is missing. Every **partial** in §3 is partial for this one reason: the
   decision is built and tested, and the input never arrives. This is also what
   leaves I9 as *deletions silently delayed*.
2. **`planJoin` is not wired in.** The startup path still authors a root from
   whatever the folder holds (§3 J2's behaviour, applied to every row).
3. **L18 (locked file) is single-node only.** Windows file semantics are the
   one thing on the list a mesh cannot settle; a Windows CI runner can.
4. **L13 (partial copy) is single-node only**, and the settle rule it tests is
   sender-side — the half of this package with the worst record.
5. **I11 (an empty incoming tree) is single-node only.** I10, its neighbour, is
   now at the mesh tier; I11 is the same shape with nothing in it.

Closed since this document was written: **L7, L8, I7, I10 and J9** now have
mesh-tier tests (`fs-mesh-matrix.spec.ts`), and the harness grew `down()` /
`up()` to express them — a stopped PROCESS rather than a broken network, which
is what a crash actually is.

## 5. Open defects referenced above

| id | defect | where it is recorded |
| --- | --- | --- |
| I12 | a writer rolled back by a receiver that is catching up — `compareTips` orders a BRANCH, so a tip wins paths it never edited | `fs-conflict-resolver.spec.ts` *orders a BRANCH, not a path* (3 ms), `fs-mesh-invariants.spec.ts` |
| J10 | a wiped node is not refilled | `fs-mesh-wiped-and-reverted.spec.ts` |
| J11 | a reverted node drags the fleet back — **J5 makes this structurally impossible once wired** | same |
| — | every node ends on the last save | `fs-mesh-invariants.spec.ts` |

---

## 6. Found by writing this down

**J9's destructive half failed on the first run, three times out of three.**

A restart reloaded the *name* of the state it was last in (`currentRef` from
`.fsagent-state.json`) and nothing about its **contents**. So the first push
after a restart computed its delta against an empty map — `first`, stating
nothing. For an addition that is harmless: the file is in the tree and travels
anyway, which is why `J9: work done while the agent was down is not lost`
passed immediately. For a **deletion** it is silent data retention: the folder
lost a file the history still names, nobody states the removal, and every peer
keeps it for ever.

Fixed by reading that state's tree back — from this node's **own** database,
so nothing is asked of the network — and seeding `_announcedContent` with it.
The delta is then computed against the state the node was really in, and the
removal is stated like any other.

**This is what the tier distinction is for.** Every decision in the join
protocol was already proven by a pure function, and the defect was not in a
decision — it was in the input never being assembled. No decision-tier test
could have found it, and no single-node test either: it needs a node that
stops, a folder that changes behind its back, and a peer that has to be told.
