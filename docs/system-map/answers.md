# Answers to the system map's open questions

The system map (build it with `npm run system-map`, then open the generated `…-system-map.html` beside this file) lists things it could not find written down anywhere. Each one is below.

**To answer one:** write your answer after `Answer:` and your name after `Answered by:`, then commit. Two sentences is plenty. The next update of the map folds the answer in, marks the claims it explains as *Brian said*, and stops asking.

**To correct the map:** add a line under `## Corrections` at the end of this file saying what is wrong and what is true.

Questions about a possible weakness appear here as one neutral line with no context. Their details are with the security contact, not in this repo. Do not answer those here.

## Q-001: Should Test Connection get the same 15-second cap on opening the SSH tunnel that a real connect has?
Context: The connection manager wraps the tunnel open in a 15-second limit; the form's Test Connection opens its tunnel directly, bounded only by the SSH handshake timeout (5 s by default, user-editable).
Answer:
Answered by:

## Q-002: Should Reset All Data also clear the remembered last-seen version, so a reset install behaves like a fresh one?
Context: Reset clears connections, secrets, query files and AI data, but the last-seen version key written on activate is left in place.
Answer:
Answered by:

## Q-003: Open question on imported connection settings, raised with Brian
Answer:
Answered by:

## Q-004: Open question on connection-string storage, raised with Brian
Answer:
Answered by:

## Q-005: Should an Athena preview read 100 rows or 500?
Context: The README and the 1.4.0 changelog say Athena previews read up to 500 rows. The query panel always asks for 100, and the driver takes the smaller number, so previews actually read 100. Its notice then says "Previews read at most 500 rows", which is wrong for what was shown.
Answer:
Answered by:

## Q-006: Is SQLite write-back finished, or still the open item the blueprint says it is?
Context: Blueprint M4 says SQLite is read-only and write-back is the one open item. task.md marks write-back done, and the code rewrites the whole file after any non-SELECT statement or grid edit. Nothing detects another program changing the file in the meantime.
Answer:
Answered by:

## Q-007: Should Redis hash and set previews be capped like lists and sorted sets?
Context: Lists and sorted sets stop at 200 elements and say so. Hashes and sets are read whole, so a key with millions of members goes to the grid all at once.
Answer:
Answered by:

## Q-008: Should previewing an Athena table under a non-default catalog work?
Context: The tree lists every data catalog. A preview builds a database.table statement with no catalog, and every query runs in the connection's configured catalog, so previewing a table from another catalog would look for it in the wrong catalog.
Answer:
Answered by:

## Q-009: On MySQL, should a query panel's raw queries actually run against the database named in its badge?
Context: The panel binds to a database and the badge names it, and task.md M18.8 lists MySQL as a multi-database engine for that binding. But the MySQL engine ignores the database it is given for typed queries, so unqualified table names resolve against the connection's configured database, while suggestions use the badge's database.
Answer:
Answered by:

## Q-010: What should Run do when the editor holds several statements?
Context: No record decides it. Reading the code, PostgreSQL appears to run them all and return a list of results the grid does not unpack (likely an empty grid with an odd status), MySQL has multiple statements off and should error, and SQLite runs them all but shows the first result set. Highlight-to-run is the documented way to pick one.
Answer:
Answered by:

## Q-011: When an inline cell save fails, should the grid put the old value back?
Context: The grid shows the new value before the database answers. On failure the status line says *Update failed*, but the cell keeps the typed value until a refresh, which can read as saved.
Answer:
Answered by:

## Q-012: Should running a saved file into the shared results panel respect that panel's query lock and run counter?
Context: The ▶ Run lens and *Run Query File* re-run straight from the extension side into the reusable results panel, so the panel's lock (which lives in the panel) is not consulted. That re-run also carries run number 0, so if someone has already pressed Run inside that panel, its result looks stale to the panel and is dropped. The lock discovery puts tree-side commands out of scope.
Answer:
Answered by:

## Q-013: Open question on query panel page hardening, raised with Brian
Answer:
Answered by:

## Q-014: How will releases be published after Azure DevOps retires global personal access credentials on 1 December 2026?
Context: Publishing today uses a vsce login with an Azure DevOps credential. The publishing guide notes global ones are being retired on 1 December 2026, and the task list has an unchecked item to publish from CI on a version tag with repository secrets. There is no CI pipeline in the repo yet.
Answer:
Answered by:

## Q-015: Should each usage record keep the price that applied when the call was made, instead of re-costing history at today's prices?
Context: Costs are worked out at display time from the current price table, so refreshing a price changes past periods. The pricing guide calls freezing cost per entry a known possible follow-up.
Answer:
Answered by:

## Q-016: Open question on AI request contents, raised with Brian
Answer:
Answered by:

## Q-017: Open question on AI consent and reset, raised with Brian
Answer:
Answered by:

## Corrections
