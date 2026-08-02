# Testing

## Automated Validation

Run strict JavaScript checking:

```sh
deno task check
```

Build the production graph with the pinned esbuild and Terser toolchain:

```sh
deno task build
```

Run the full suite:

```sh
deno task test
```

The latest completed candidate passed `461/461` tests. Its aggregate JavaScript
is `181,639` bytes raw and `57,528` bytes gzip; CSS is `23,993` bytes raw and
`5,355` bytes gzip. Treat the executable tests and build output as authoritative;
update these figures only after a fresh complete validation.

## Browser Acceptance

After `deno task build` and `deno task serve`, validate:

- Feed, Review, Library, Discover, and Settings at `360x800`, mobile landscape,
  `768x1024`, `1440x900`, and `1920x1080`, plus 200% text zoom.
- Keyboard-only navigation, visible focus, reduced motion, forced colors, and no
  serious accessibility violations.
- Real IndexedDB reload, export, quarantine recovery, theme/sound persistence,
  erase, and service-worker offline reload.
- Access-authenticated source browse, search, approval, rejection, suppression,
  deactivation, retry, quota, offline, and partial-provider states.
- Central Discover query normalization, educational filtering, provider
  selection, result limit, canonical deduplication, and add/reject workflows.
- YouTube policy disclosure and metadata/link-only behavior without media,
  captions, or automatic transcripts.
- Browser Run destination/redirect enforcement, rights failures, bounded
  traversal, R2 capacity, and cleanup against controlled fixtures.

Record browser version, viewport, Worker version, test account, and evidence for
every hosted acceptance run.
