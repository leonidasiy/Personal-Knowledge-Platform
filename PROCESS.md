# Resonance Learning Build Process

You should follow this process to build and maintain the entire project:

1. Build each milestone as documented in `documentations/spec.md`. Use the
   current `README.md`, `documentations/REFERENCE.md`, `documentations/ENV.md`,
   `documentations/TESTING.md`, and `deno.json` when they are directly
   applicable. Before implementation, record the goal, acceptance criteria,
   scope, checklist, and proposed happy-path, boundary, and named-failure
   tests in the project documentation, then wait for approval.
2. Ensure all acceptance criteria and approved tests are met. Record proposed,
   approved, and completed validation in `documentations/TESTS.md`. Preserve
   accessibility, privacy, provenance, licensing, typed failure contracts,
   and the feature boundaries documented for this project.
3. Run the narrowest relevant checks first, followed by `deno task check`,
   `deno task test`, `deno task build`, and the applicable browser,
   accessibility, offline, and hosted acceptance checks. Use an independent
   validation or product-review pass for the final product when the runtime
   provides one.
4. Incorporate approved changes, rerun affected validation, and update the
   project documentation whose defined purpose requires it. Keep credentials
   out of source, browser state, logs, prompts, and generated artifacts, and
   do not commit or push unrelated worktree changes.
5. IMPORTANT: follow the instructions in `SELF_IMPROVEMENT.md` to improve the
   process. Update this `PROCESS.md` with lessons learned and complete the
   recursive self-improvement step.

You must complete step 5 before you stop.

## Lessons From This Process Setup

- Verify filenames and available review tooling before reusing a template:
  this project has no `REQUIREMENTS.md` or `product_review` subagent, so the
  workflow points to the current specification, approved test ledger, and an
  independent validation pass when available.
- Preserve unrelated worktree changes. The existing `package.json` and
  `package-lock.json` modifications were left untouched.
- For documentation-only work, distinguish reference checks and focused test
  results from a full production build result; do not claim a build passed
  unless that build has been run and its output inspected.
- The project-local `SELF_IMPROVEMENT.md` is now authoritative, so future
  recursive improvements can be made within the repository and validated with
  the rest of the project documentation.
