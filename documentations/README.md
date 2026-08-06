# Personal Knowledge Platform Documentation

This directory contains the current product, engineering, setup, and validation
records. Superseded decision pages are removed after their accepted outcomes are
captured in `REFERENCE.md` or `PROJECT_STATUS.md`.

## Current Work

Milestone 3F.1 is complete: automatic Feed reveal and established-client shell
freshness passed strict checking, all `526/526` repository tests, independent
validation, and hosted acceptance against Worker
`c2e752bf-868d-4dad-9b01-aef77b5e08fc`. Milestone 3F.2 is complete: fixed
Combined Library search uses a bounded local semantic index plus D1 keyword
retrieval, with hosted smoke acceptance against Worker
`97803204-e09c-49a3-9bf5-15d5043f8871`. The current production browser budget remains
`182,500` raw / `58,000` gzip aggregate JavaScript.

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
