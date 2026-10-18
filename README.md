# Resonance Learning

Resonance is a private learning platform for turning permitted sources into
source-linked knowledge cards and retrieval-practice quizzes. Music is its first
subject; extraction now uses a fixed 22-subject taxonomy with source-specific
subcategories. Fieldnotes is the light theme and Observatory the dark theme.

## Set up your own copy on computer and phone

Start with [SETUP.md](SETUP.md) to compare two complete setups:

- [Run the backend on your computer](COMPUTER_SETUP.md): local database/storage,
  password login, your own API keys, and private phone access. No Cloudflare
  account; the computer must stay on.
- [Deploy to your own Cloudflare account](SELF_HOSTING.md): hosted app, database,
  files and login, plus [your acquisition server](ACQUISITION_SETUP.md) for web
  extraction. More setup and cloud services, with learning available when your
  computer is off.

Both use [your own API services](SERVICES.md), never the maintainer's credits.
The repository includes the runtime, lockfiles, assets, agent configuration,
migrations, new-install seed and safe configuration examples. No private
maintainer files are required. A separate [sample demo](SETUP.md#run-the-local-demo)
needs no API keys. Phone installation opens your backend; it does not run one
on the phone.

The original `wrangler.jsonc` is the maintainer's deployment configuration.
For your account use `wrangler.self-host.example.jsonc` and the guide above.

## Use the learning workflow

Open **your own backend URL** and sign in with your local password or
Cloudflare Access policy. The maintainer's private deployment is not a shared backend for forks.
Enable optional discovery providers only with your own keys; use direct uploads
until any required acquisition service is provisioned.

1. In **Discover**, search for an educational source and choose **Add to
   Library** when its rights evidence permits processing. If acquisition is
   blocked or permission is unclear, use the offered authorized-upload path.
   For your own file, open **Library → Upload a private document**.
2. Enter a title if needed; paste text or select a `.txt`, `.md`, `.pdf`,
   `.pptx`, PNG, JPEG, WebP, or GIF file. Text processing is the default.
   Select **Process images in uploads** only when you want visual analysis of
   raster images or PDF pages. A blank PDF page range means all pages; `1,3-5`
   selects specific pages. Confirm that you have permission for storage,
   transformation, and external AI processing, then choose **Upload and process**.
3. Watch the source in **Library**. Its card refreshes every minute with the
   current page/section, extracted points and generated question count. It reports a named reason when
   action is needed, or **Knowledge extraction and paired question generation
   completed**. If a transient failure shows **Retry processing**, use that
   control. Related knowledge appears with the source after processing.
   **Cancel processing** asks for confirmation and removes that run's points,
   quizzes and associated images.
4. Open **Feed** to study a five-card batch. Reach the bottom and choose **Mark
   batch studied** to unlock its paired questions. If no batch is available,
   at least five eligible published knowledge-and-quiz pairs are needed.
5. Open **Review** to answer the unlocked questions. Submit with **Check
   answer** to see feedback; uncertain text answers remain pending until the
   grader is available. Review intervals follow your completed attempts.

Semantic text grading uses `~typesafe/jev-latest` and accepts answers at ≥70%
correctness probability. Exact answers and choices use answer-key checks.
The production MiMo reviewer approves extracted points and quizzes before
publication; external test evaluation does not control publication.

Only upload material you are allowed to use. Source rights checks, access
controls and private storage apply in both full backend modes. The sample demo
uses separate browser-local records.

## Project map

Library offers subject shelves and source/knowledge search. Feed cards reveal
as you scroll; missing associated imagery leaves no placeholder box. Progress
shows daily and subject review accuracy, activity, scores and attempt totals.
Historical unclassified records are preserved without backfills.

See [setup and everyday use](SETUP.md) for installation, reminders, data and offline limits.
