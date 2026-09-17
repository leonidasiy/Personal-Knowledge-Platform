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
- daily and seven-day recall accuracy with a top-level Review surface fed by
  studied knowledge and bounded daily batches.
- a lazy, owner-scoped Discover inbox for RSS/Atom, podcast, and official YouTube metadata;
- rights-reviewed publisher excerpts plus authorized pasted text, PDF, and
  PPTX material routed through the automatic knowledge-and-quiz workflow; and
- five-card Feed batches, studied-card gating, paired Review questions, and
  source/knowledge deletion that removes the related learning projections; and
- a tested local-ASR companion protocol with rights gates, authenticated pairing, bounded leases, pinned-model checks,
  and mandatory temporary-media deletion.

The local learning experience remains credential-free. Activating live discovery
and live model-backed workflow execution requires the documented Cloudflare
Access, private storage, and provider configuration. A packaged ASR
model/daemon, automatic pairing, hosted sync, audio/video processing, and
browser-heavy workflow UI remain deferred.

See [local setup](documentations/SETUP.md), [validation commands](documentations/TESTING.md), and the
[current milestone specification](documentations/spec.md).
