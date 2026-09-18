# Resonance Learning

Resonance is a private learning platform for turning permitted sources into
source-linked knowledge cards and retrieval-practice quizzes. Music is its first
subject; the workflow can support other knowledge areas.

## Try it locally

Install Deno 2, Node.js/npm, and Python 3.
From a fresh clone:

```sh
git clone --branch feat/milestone-5-knowledge-workflows https://github.com/leonidasiy/Personal-Knowledge-Platform.git
cd Personal-Knowledge-Platform
npm ci
deno task build
deno task serve
```

Open <http://localhost:4173>. This build uses local starter content and browser
storage; it needs no API key or Cloudflare account. The local server does not
run the hosted extraction and quiz APIs. Use **Library → Export** before
clearing browser data if you want to keep local records.

Run `deno task check` and `deno task test` to validate changes. The test suite
reads the built asset manifest, so build first on a fresh clone. See
[SETUP](documentations/SETUP.md) and [TESTING](documentations/TESTING.md) for
more detail.

## Use the hosted knowledge workflow

The [hosted site](https://resonance-discovery.lirenleonidas.workers.dev) is
private. Sign in through Cloudflare Access with an authorized account. Hosted
source processing needs the configured Worker, D1 database, private R2 bucket,
and model secret; operators can follow [hosted setup](documentations/SETUP.md#hosted-worker-setup)
and the [environment reference](documentations/ENV.md).

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
3. Watch the source in **Library**. It reports processing, a named reason when
   action is needed, or **Knowledge extraction and paired question generation
   completed**. If a transient failure shows **Retry processing**, use that
   control. Related knowledge appears with the source after processing.
4. Open **Feed** to study a five-card batch. Reach the bottom and choose **Mark
   batch studied** to unlock its paired questions. If no batch is available,
   at least five eligible published knowledge-and-quiz pairs are needed.
5. Open **Review** to answer the unlocked questions. Submit with **Check
   answer** to see feedback; uncertain text answers remain pending until the
   grader is available. Review intervals follow your completed attempts.

Only upload material you are allowed to use. Source rights checks, access
controls, and private storage are part of the hosted path; local fixture study
and hosted processing are separate modes.

## Project map

- [Documentation index](documentations/README.md)
- [Current specification](documentations/spec.md)
- [Project status](documentations/PROJECT_STATUS.md)
- [Recent changes](documentations/RECENT_CHANGES.md)
- [Validation and known limits](documentations/TESTING.md)
