# Personal Knowledge Platform Agent Rules

## Product Scope

- Build a personalized learning platform that starts with music knowledge and can later support other knowledge domains.
- The web experience comes first. Preserve a practical migration path to an Android application after the website is verified.
- Core product capabilities include content ingestion, an on-demand social feed, preference learning, active recall,
  spaced review, progress tracking, and transparent personalization controls.
- Treat external content as attributed source material. Preserve provenance and respect licensing, access controls,
  privacy, and platform terms.

## Milestone Workflow

- Break large tasks into small, reviewable milestones.
- Start each task with a short `documentations/spec.md` containing the goal, acceptance criteria, files in scope,
  files out of scope, and an implementation checklist.
- Maintain proposed, approved, and completed validation work in `documentations/TESTS.md`; do not duplicate it in the
  specification.
- Before implementation, propose tests for happy paths, boundaries, and each named failure mode, then wait for user
  approval.
- Whenever a major milestone is complete, present its results to the user and wait for approval before proceeding to
  the next milestone.
- Review and commit only the approved, validated milestone. Push only when a Git remote exists and the user has
  approved the milestone; never include unrelated worktree changes.
- Update `documentations/README.md` before milestone commits. Update `documentations/TODO.md`,
  `documentations/RECENT_CHANGES.md`, and `documentations/PROJECT_STATUS.md` only when their defined purpose requires it.

## Grilling Sessions

- At the start of substantial work, use the `grilling` skill unless the user opts out.
- Present all related decision questions together in one concise set. Do not ask them one at a time.
- Do not begin execution until the user confirms the shared understanding.

## Subagent Coordination

- Summon subagents for bounded specialist work such as research, frontend design, backend design, security review, test
  design, and independent validation when the task genuinely benefits from delegation.
- Always request the `gpt-5.6 terra` model with `medium` reasoning for subagents when the runtime exposes model
  selection. If it does not, disclose that limitation and use the runtime-selected subagent model without claiming a
  model that cannot be verified.
- Give every subagent one ownership boundary, typed inputs and outputs, relevant project context, and explicit stop
  conditions.
- Use separate Git worktrees for concurrent editing once the project is a Git repository. Research-only agents may
  work without a worktree because they do not edit files.
- Run tests and validations through a separate subagent so verification is independently executed and reported.
- For code reviews, use separate subagents for security risks, test gaps, and maintainability when concurrency and
  scope justify three reviewers.
- When designing a purpose-built agent, agent workflow, or multi-agent system, follow the `agent-skill-design` skill.

## Design Decisions

- Before implementation, explicitly check whether the proposed product and technical design fits the user goal,
  current repository conventions, accessibility expectations, privacy requirements, and current stable coding
  standards.
- When several viable implementation or design choices require user input, present the alternatives as a viewable
  HTML artifact and wait for the user's selection. Ask simple operational questions directly without generating an
  HTML decision artifact.
- Record consequential decisions and rejected alternatives in the current specification or a dedicated decision
  record rather than hiding them in code.
- Prefer the smallest architecture that satisfies the approved milestone and keeps the domain model generalizable.

## Engineering Contracts

- Pass configuration, clients, credentials, clocks, environment access, and external dependencies explicitly. Do not
  access shared configuration from business logic.
- Use typed module boundaries. Do not use `any` or untyped dictionaries.
- Return a typed `Result` with one named variant per expected failure mode. Reserve named exceptions for programmer
  errors and broken invariants.
- Validate every public entry point. Do not use silent fallbacks, bare catches, masking defaults, or generic errors.
- Define public signatures and failure contracts before implementations.
- Organize code by feature. Features must not import from one another directly; integrate them at composition
  boundaries.
- Apply the rule of three before introducing shared abstractions. Prefer limited blast radius over premature reuse.
- Keep changes to five files or fewer per active editing unit. Split larger scopes into coordinated milestones or
  subagent-owned worktrees.

## Discovery And Domain Data

- Do not hard-code open-ended knowledge categories, content types, creators, genres, aliases, or source identities in
  reusable logic. Discover them from content, metadata, schemas, attributed configuration, or user contracts.
- Never infer a source's identity, author, domain, licensing state, or role from its filename or path alone.
- Preserve filenames only as provenance. Return distinct missing, unknown, conflicting, and ambiguous outcomes when
  evidence is insufficient.
- Keep authoritative package-specific values in typed, source-attributed configuration and inject them at the
  composition boundary.
- Never turn unknown or ambiguous evidence into a known identity or silently select the first candidate.

## Content And AI Safety

- Keep API keys and credentials out of source control, browser bundles, logs, prompts, and generated artifacts.
- Ask the user for required credentials only when the approved milestone needs them. Provide the exact environment
  variable names and least-privilege setup.
- Do not send private notes, proprietary documents, or credentials to external AI or content services without explicit
  user approval.
- Make AI-generated explanations and quizzes distinguishable from source-authored material, with provenance links
  where available.
- Do not reproduce copyrighted source material beyond licensed storage or brief, attributed excerpts. Prefer user
  notes, metadata, links, and transformative summaries.

## Frontend

- Build an accessible, responsive, keyboard-operable interface with clear loading, empty, offline, and error states.
- User-facing errors must be non-technical and must not expose stack traces, raw exceptions, payloads, credentials, or
  internal identifiers.
- Use lazy loading and responsive images for media. Defer non-essential JavaScript, minimize client bundles and server
  calls, limit web-font weights, and use appropriately compressed media formats.
- Make ranking controls understandable: users must be able to express preferences and understand why an item is being
  shown.
- Keep the feed loading on demand. Do not fetch an unbounded content corpus into the browser.

## Documentation

- Keep each documentation file single-purpose and cross-reference instead of duplicating:
  - `documentations/README.md`: project overview and documentation index
  - `documentations/SETUP.md`: prerequisites and local setup
  - `documentations/TESTING.md`: stable test and type-check commands
  - `documentations/ENV.md`: environment variables
  - `documentations/REFERENCE.md`: domain and architecture reference
  - `documentations/spec.md`: current milestone specification
  - `documentations/TESTS.md`: proposed, approved, and completed test specifications and results
  - `documentations/TODO.md`: durable handoff decisions and next steps
  - `documentations/RECENT_CHANGES.md`: concise recent completed changes
  - `documentations/PROJECT_STATUS.md`: cumulative milestone status
- Do not commit confidential source documents or private reference materials without explicit approval.

## Validation

- Run the narrowest relevant tests for the changed behavior.
- For documentation-only work, validate the repository file list and search for unrelated project carryover.
- Never weaken a test to accommodate broken code. Flag incorrect test expectations explicitly.
