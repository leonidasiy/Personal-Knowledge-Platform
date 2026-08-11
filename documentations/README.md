# Personal Knowledge Platform Documentation

This directory contains the current product, engineering, setup, and validation
records. Superseded decision pages are removed after their accepted outcomes are
captured in `REFERENCE.md` or `PROJECT_STATUS.md`.

The repository-wide build workflow is documented in [`../PROCESS.md`](../PROCESS.md).

## Current Work

Milestone 3E replaces Podcast Index with Taddy Free for show/feed-level podcast
discovery. Brave Search, Taddy, and official YouTube metadata share the same
educational query and metadata policy. The local candidate passes strict
checking and all `465/465` tests; independent validation also passes. Aggregate
JavaScript remains `181,639` bytes raw and `57,528` bytes gzip. Taddy activation
and hosted acceptance await milestone approval and server-secret setup.

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
