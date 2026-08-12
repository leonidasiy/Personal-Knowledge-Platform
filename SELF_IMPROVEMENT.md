# Self-Improvement Step

IMPORTANT: Complete this step before stopping after every major project milestone or
debugging session.

## Required review

1. Look back at the work completed for the project, including challenges
encountered, bugs found, decisions made, and feedback received.
2. Identify strengths and weaknesses. Support the observations with concrete
evidence from the work.
3. Self-improvement: update the applicable project `PROCESS.md` with the
lessons learned so that the process improves in the future. If the file is
missing or cannot be updated, create it and/or report that clearly rather than silently
substituting another file.
4. Recursive self-improvement: update this `SELF_IMPROVEMENT.md` file so that
the self-improvement process becomes more effective based on the latest
learnings.

The recursive step is mandatory. Every run must leave this document more
useful, specific, or effective when the review produces a valid improvement. (maximum 10 points to be kept)

## Project-local application

- This project-local copy is authoritative for this repository; update it
  instead of the global source file.
- Keep improvements concise, evidence-backed, and limited to at most 10 active
  points so the guidance stays actionable.
- When a change affects the workflow, update `PROCESS.md` and record the
  relevant validation evidence in `documentations/TESTS.md`.
- For a hosted UI bug, treat deployment provenance as an explicit acceptance
  check: record the source tree, build completion, deployed asset identity, and
  browser-visible state before concluding that a fix is live.
- When a route combines transient search data with persisted data, test both
  the list and detail transition; a fallback that is correct for list loading
  can still silently replace the active projection after navigation.
- For hosted SPAs with an offline shell, validate cache strategy separately
  from application state; a correct deployed bundle is ineffective if the
  service worker keeps returning an older document graph.
- Before reporting a hosted fix, record four concrete gates: deployment
  worktree, successful build, generated marker/asset identity, and live browser
  result. If sandbox permissions block the last gate, report it explicitly and
  give the user the exact authenticated command rather than implying success.
- Include `/service-worker.js` in the freshness check itself; otherwise an old
  worker script can keep serving an old application cache even after the asset
  graph is rebuilt. Cover this path with an offline-shell regression test.
