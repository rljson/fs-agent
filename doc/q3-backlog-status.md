<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# The Q3 backlog, answered from this package

`2026_Q3 — Innenleben-Serverless` lists 28 quality and stability items, every
one of them still marked **Offen**, and every one naming the test that would
prove it. Eleven are `Dateisync` items this package can answer. This document
says where each actually stands, measured rather than assumed.

**Why the statuses moved without anyone updating the board.** Most of these
items were written when the sync inferred a deletion from a tree's silence.
The edit chain removed that inference, and several items were about its
consequences — so they did not get fixed one at a time, they stopped being
reachable. The rest named a test as MISSING that has since been written.

---

## Closed

### X1 — Anti-Entropy-Abgleich zwischen den Rechnern · Kritisch

> *"Es gibt keinen Schritt, in dem zwei Rechner ihre Ordner vergleichen. Geht
> eine Meldung verloren, findet das System von allein nie wieder zusammen — und
> niemand erfährt es."*
>
> Named test: `heals-after-forced-divergence` — **MISSING. The one test that
> would have caught almost every measured defect.**

**Built, and that test exists and is green.**
`test/client-server/heals-after-forced-divergence.spec.ts`, 15 cases, among
them *delivers a new file whose push the hub never received*, *delivers a
deletion a peer never received*, *does not undo a peer deletion it missed*,
*heals every node when the hub received nothing at all*, and *repairs a node
that misses every forward while another keeps writing*. It also keeps the
original failure as its own case — *stays divergent after a lost push — the
defect this ticket fixes*.

The mechanism is `src/fs-anti-entropy.ts`: a per-folder checksum in the
heartbeat, a bundled comparison, and targeted catch-up — which is the shape X1
asks for. 46 further tests cover the decision function, 10 of them
enumerations over *every pair of views* rather than examples, because the
defect class here is "two situations needing opposite actions arrive as the
same value".

One thing X1 asked for that went further: a node that is **behind now ASKS**
rather than waiting to be told. That is what refills a wiped node, and it is
what closed *every node ends on the last save*.

### X3 — Glob-Muster für Ignore-Listen · Kritisch

> *"Der heutige Vergleich lautet „Name ist gleich oder beginnt damit". Damit
> lässt sich keine Dateiendung ausschließen — `*.exe` trifft nichts. Die
> gelieferte Liste wäre nicht anwendbar."*

**Built: `src/fs-ignore.ts`, 27 tests.** `*`, `?`, `**`, folders with `/`,
anchored at the root, `!` exceptions with last-match-wins, case-insensitive,
and `/` ≡ `\` in both path and pattern.

It was worse than the item says. The One Client **already ships `'*.log'`** in
its default ignore list, where it has never matched anything; and
`ensureSystemIgnores` in that package actively *strips* `~$*`, `~*.tmp` and
`.~lock.*` from older config files, with the comment *"FsScanner uses
startsWith, so '~$*' is a literal prefix that never matches anything useful"*.
Somebody wrote globs, they silently did nothing, and the workaround was to
delete them.

**The compatibility rule is the reason this is safe to land.** A pattern with
none of `*`, `?`, `/`, `\`, no leading `!` and no trailing `/` keeps its old
meaning exactly — equal to, or a prefix of, any segment. That is not courtesy
to old configs: `~$` and `.~lock.` are the Office and LibreOffice lock
prefixes the product depends on, and `.fsagent-tmp-` is how this agent hides
its own in-progress writes from its own watcher. Under pure glob semantics all
three would match only a file named exactly that, and every atomic write would
come back as a change event — a defect this package has already had once.

A second bug fixed on the way: the directory walk tested `entry.name`, so a
pattern containing `/` could never have matched even with a glob engine
behind it. It now tests the relative path.

**→ One follow-up in `cos-one-client`, and it is not optional:**
`ensureSystemIgnores` must stop stripping `~$*`, `~*.tmp` and `.~lock.*`, and
its two comments claiming prefix-only matching are now wrong. Left alone
deliberately — it is another repository.

### F5 — Übertragungszeiten je Schritt messen · Hoch

> *"Bisher wird nur die Gesamtzeit gemessen. Die einzelnen Schritte mitmessen —
> Scan, Prüfsumme, Ablage, Meldung, Abholen, Schreiben —, sonst rät man."*

**Built.** `test/fs-stage-timings.spec.ts`: *attributes the send side: scan and
announce*, *attributes the receive side: fetch, write and re-derive*, and
*reports the LAST cycle, not a running total* — which is the distinction that
makes a slow run readable rather than averaged away.

### F1 — Problematische Dateinamen und Umbenennen · Kritisch (the test half)

> Named tests: `impossible-filename` — **MISSING**; `rename-folder` —
> **MISSING. Vorher zwei Tests dafür schreiben — es gibt bis heute keinen.**

**Both exist and are green**: `test/fs-impossible-filename.spec.ts` (4) and
`test/fs-rename-folder.spec.ts` (2), with `test/fs-hostile-tree.spec.ts` (4)
and `test/fs-filenames.spec.ts` (5) beside them — a German filename surviving
a round trip byte for byte, two Unicode spellings of one name not destroying
each other, and a case-only rename not losing the file.

D2's requirement — *"nur diese eine Datei überspringen und melden, den Rest
normal schreiben"* — is proven at mesh tier as **F8**, *one unwritable path
does not block the rest of the tree*. D5's — *"für das System ist ein
Umbenennen alles löschen und neu anlegen, damit läuft es in die Löschsperre"* —
is proven three times: *one rename does not look like a mass deletion*, and
matrix **L7** (renaming a directory) and **L8** (a file moved between
directories, never duplicated or lost).

What is NOT closed here is Y2, the naming RULE — no paths over 200 characters,
no reserved Windows names, nothing with a trailing space or dot. That is a
check at creation time in the product, not something this package can impose
on a folder it is given.

### F4 — Löschungs-Übertragung verlässlich reproduzieren · Hoch

> *"Offen lassen, bis eine zweite unabhängige 20er-Messung dasselbe zeigt."*

**The premise is superseded.** Deletion propagation is no longer a thing to
measure in runs of twenty, because it is no longer probabilistic: a removal is
written down in the chain by the node that performed it, and the receiver
applies what is stated rather than inferring from absence. It is asserted
deterministically by T2, T4, A2, mesh F1 and F7, matrix I7 and J9, and 50
decision tests over `collectRemovals` and `planRemovals`.

The scenario the item was written from — T4 — was a coin flip through four
work packages and is **8 of 8** under `bucketSync`. A second 20-run lab
measurement would confirm something already proven more cheaply; the two
22-second and 33-second outliers it also wanted explained belong to **F5**,
which now measures per stage.

### V4 — Gesperrte CARAT-Dateien · Hoch (the question it asked)

> *"Zuerst prüfen, ob das bereits gebaute Überspringen greift. Kommt der Rest
> an, ist es kein Sperr-Problem, sondern das Zustellproblem D1."*

**Answered: it is not a lock problem.** `test/fs-agent-locked-file.spec.ts`, 7
cases, proves the skipping works and the rest of the restore lands — including
*still delivers every other file in the same restore*, *reports every locked
file, not just the first*, *still aborts on a write failure that is not a
lock*, and *does not advertise the half-applied state to peers*, which is the
one that matters for the fleet.

It remains single-node. Windows file semantics are the one thing on this list
a mesh on macOS cannot settle, so the mesh-tier version wants a Windows
runner — it is `scenario-matrix.md`'s L18.

---

## Partly closed

### L1 — Großlöschungen kontrolliert freigeben · Kritisch

Two of the four sub-problems are gone, and the remaining one is the item's
actual point.

- **M3/D6's silent rollback is structurally impossible.** *"Die anderen
  Rechner spielen die Daten wieder zurück. Die Löschung des Nutzers wird still
  aufgehoben"* — peers rolled a deletion back because they inferred one side's
  state from a tree that merely lacked the paths. Nothing infers that any more.
- **C6's `burst-delete` is green at mesh tier**: F7, *a burst of 100 deletions
  out of 400 files completes everywhere*. The item recorded it red 1 run in 6
  with a 10-minute abort.
- **Still open, and it is the headline: there is no approval path.** An
  intended deletion over the threshold is still refused, and
  `approved-mass-delete` still does not exist. `fs-agent-mass-delete-guard.spec.ts`
  has 15 cases including *allows a large deletion that is still a minority of
  the folder* and *reports what it refused, so the numbers can be judged* — so
  the refusal is now legible, which U5 asked for. Turning it into a decision
  needs a UI affordance and a way to carry the approval, which is not this
  package alone.

One finding to carry into that work: the two floors in this package are now
deliberately different, and the band between them is a gap. A receiver refuses
to APPLY an emptying state from ten files up, because refusing is free; an
author refuses to ANNOUNCE one only above a hundred, because refusing there
resurrects the user's own deletion. A wipe of 11–99 files is therefore refused
by the fleet and the wiped node is **not refilled** — no data is lost anywhere,
but one machine sits empty. Recorded as J10b in `scenario-matrix.md`.

### V2 — Erst nach vollständigem Schreiben verteilen · Kritisch

- **D3 is built and tested.** *"Wartezeit im Scanner: eine Datei erst lesen,
  wenn Größe und Zeitstempel sich kurz nicht mehr geändert haben, und nach dem
  Lesen erneut prüfen"* — `test/fs-slow-copy.spec.ts`: *never hashes a partial
  copy*, *keeps the last known content while a file is overwritten*, *one
  unsettled file does not stop the rest of the folder*. The named test
  `slow-copy-in-progress` was MISSING; this is it, at single-node tier. A
  40 MB file written over 20 seconds across a real fleet is still only a lab
  measure.
- **D8's half that this package owns is built.** *"Nur den geänderten Pfad bis
  zur Wurzel neu rechnen"* — `fs-scale` asserts *a second scan re-reads
  nothing* at 4 000 files, with a GUARD that *one changed file is the only
  thing re-read*. The 100 000-file catalogue and the 48-minute cold start are
  not reachable in this suite.

### L2 — Garbage Collection · Kritisch

- **Both named tests exist.** `disk-full` was MISSING —
  `test/fs-disk-full.spec.ts` has 3 cases. The 24-hour soak was MISSING —
  `fs-scale` T1 is it, parameterised: `FS_SOAK_MS=14400000` runs the four
  hours the register asks for and nothing about the test changes.
- **M8's "zwei unbegrenzte Listen begrenzen" is done on the file side.** T1
  asserts the tombstone log's bound under churn, and
  `fs-agent-announced-heads.spec.ts` asserts the parked-head cap *forgets the
  oldest past the cap*.
- **The GC mechanism itself is not built.** D4 — *"Aufräumen nach
  Erreichbarkeit — die Cloud hat diese Regel bereits, die Clients nicht"* —
  stands. Every old version of every file still stays on every machine for
  ever.

---

## Open

### V1 — Große Dateien in Blöcken übertragen · Kritisch

Content-defined chunking is **not built**, and it is the one item on this list
whose absence is a hard ceiling rather than a risk: the largest customer file
is 45.9 MB against a 50 MB transport limit — 92 % — and `.PRJZ` is confirmed to
be moving to unpacked `.PRJ`, which is a multiple of that.

What did move: blob transfer is **streamed**, so a file larger than one socket
message is no longer the limit it was
(`test/fs-agent-blob-stream.spec.ts`), and the 50 MB per-message ceiling that
made C1 red is gone. But neither named test exists —
`large-file-above-cap` (a file beyond the limit refused cleanly rather than
taking every connection down with it) nor `large-file-beyond-cap` (one
transferring completely in chunks). **Establish what the limit now is first**;
asserting a cap nobody has measured would pin a number rather than a
behaviour.

### F6 — 8-MB-Datei ohne Zustellung nachmessen · Hoch

> *"Größe allein erklärt es nicht. Zuerst nachmessen, denn im selben Lauf
> starteten zwei Rechner neu."*

The item's own suspicion is now the likely answer. Multi-megabyte crossing is
green off-lab — mesh **F9** (crosses *and* leaves no residue when deleted) and
`advanced-sync` at 10 MB and 5 MB binary — while a silent node exit is a
documented failure mode of that lab run. Needs one clean re-measurement with
the node restarts ruled out, not an investigation.

---

## Not this package

| item | belongs to |
| --- | --- |
| E1, E3, F8, L3, L4, K2, X5 | operations, network, the EventHub |
| E2 | the CARAT test lab itself |
| K1, F9, X6, F3 | the One Client UI (bulk-operation mode, revision lists, network-wide conflict resolution) |
| V3, F2, F7 | `@rljson/mongo-agent` |
| X4, X7 | CARAT Desktop |

`X1`'s mechanism is the one of these this package can lend: F2's
*heals-after-forced-divergence* half is the same anti-entropy shape, already
proven here.
