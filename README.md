# Resonance Learning

Resonance is a private, adaptive learning platform that starts with music knowledge and can generalize to other
subjects. Accepted Milestone 2C and the Milestone 3 acceptance candidate provide:

- a bounded, loading-on-demand lesson feed;
- separate preference, qualified-exposure, and recall signals;
- active-recall quizzes scheduled by pinned `ts-fsrs` v5.4.1;
- owner-scoped IndexedDB persistence, export, and erasure;
- offline shell caching and install metadata;
- five rights-safe music fixtures spanning every supported question type;
- configurable exact-size daily study sets and smaller independent recall cohorts;
- adaptive prompt eligibility after a ten-minute floor; and
- daily and seven-day recall accuracy with a Library-owned review queue.
- a lazy, owner-scoped Discover inbox for RSS/Atom, podcast, and official YouTube metadata;
- rights-reviewed publisher excerpts, private notes, and user-original evidence without automatic quiz creation; and
- a tested local-ASR companion protocol with rights gates, authenticated pairing, bounded leases, pinned-model checks,
  and mandatory temporary-media deletion.

The local learning experience remains credential-free. Activating live discovery requires the documented Cloudflare
Access and YouTube configuration. A packaged ASR model/daemon, automatic pairing, hosted sync, general upload
analysis, and AI enrichment remain deferred.

See [local setup](documentations/SETUP.md), [validation commands](documentations/TESTING.md), and the
[current milestone specification](documentations/spec.md).
