# Resonance Learning

Resonance is a private learning platform for turning permitted sources into
source-linked knowledge cards and retrieval-practice quizzes. Music is its first
subject; extraction now uses a fixed 22-subject taxonomy with source-specific
subcategories. Fieldnotes is the light theme and Observatory the dark theme.

## Use it on your computer or phone

Open the [private live site](https://resonance-discovery.lirenleonidas.workers.dev)
and sign in with your authorized email. No development tools are needed.
You can use the browser or install its desktop/home-screen web app.
Follow [desktop, Android and iPhone/iPad setup](SETUP.md#use-the-live-app).
For a sample version on your own computer, follow the step-by-step
[local demo setup](SETUP.md#run-the-local-demo). Hosted processing requires the live service.
Settings controls appearance, motion, sound and optional daily reminders and source-processing alerts.
YouTube information is tucked into a collapsed Settings disclosure. Card entrances
respect both the motion toggle and your device's reduced-motion preference.
Reminders are available for Android Chrome; enable them in Settings on each device.

## Use the hosted knowledge workflow

The [hosted site](https://resonance-discovery.lirenleonidas.workers.dev) is
private. Sign in through Cloudflare Access with an authorized account.

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
controls, and private storage are part of the hosted path; local fixture study
and hosted processing are separate modes.

## Project map

Library offers subject shelves and source/knowledge search. Feed cards reveal
as you scroll; missing associated imagery leaves no placeholder box. Progress
shows retrieval, spacing, activity and subject summaries without confidence
metrics. Historical unclassified records are preserved without backfills.

See [setup and everyday use](SETUP.md) for installation, reminders, data and offline limits.
