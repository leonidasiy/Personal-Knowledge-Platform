# Personal Knowledge Platform Documentation

This directory contains the current product, engineering, setup, and validation
records. Superseded decision pages are removed after their accepted outcomes are
captured in `REFERENCE.md` or `PROJECT_STATUS.md`.

## Current Work

Milestone 3F adds a typed, redacted Playwright release gate for the private
hosted product and repairs live Discovery state, Discover-to-Library refresh,
and Brave mixed-transport response handling. The hosted desktop/mobile journey
passes against Worker `6e0768f8-1dd9-4b07-a42a-48ad31af5d8a`; all `524/524`
tests and strict checking pass. Aggregate browser JavaScript is `181,935` bytes
raw and `57,807` bytes gzip, within the fixed budget.

## Authoritative Documents

- [`spec.md`](spec.md): current milestone scope, acceptance criteria, and work
  units
- [`TESTS.md`](TESTS.md): current approved tests and concise validation history
- [`PROJECT_STATUS.md`](PROJECT_STATUS.md): cumulative implementation status
- [`REFERENCE.md`](REFERENCE.md): durable product and architecture decisions
- [`TODO.md`](TODO.md): active handoff tasks only
- [`RECENT_CHANGES.md`](RECENT_CHANGES.md): recent completed changes
- [`SETUP.md`](SETUP.md): local build and deployment setup
- [`ENV.md`](ENV.md): active Worker bindings, variables, and secret boundaries
- [`TESTING.md`](TESTING.md): stable validation commands and browser checks

## Decision Artifacts

- [`milestone-3-podcast-provider-recovery-options.html`](milestone-3-podcast-provider-recovery-options.html):
  approved Taddy Free provider-replacement decision
- [`milestone-3-central-search-options.html`](milestone-3-central-search-options.html):
  approved Provider A and hybrid source-boundary decision
- [`frontend-customization-options.html`](frontend-customization-options.html):
  retained because the live theme configuration cites it as provenance
