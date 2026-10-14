# Setup and everyday use

## Choose how to use Resonance

| What you want | Where to start |
| --- | --- |
| Use all features on a computer or phone | [Use the live app](#use-the-live-app). No coding tools or API keys needed. |
| Run a sample version on your own computer | [Run the local demo](#run-the-local-demo). This uses sample content and separate local data. |

The full learning service runs online. Installing its icon on your device does
not move the server onto that device. The live site is private: ask the site
owner to authorize your email before signing in.

## Use the live app

Open [Resonance](https://resonance-discovery.lirenleonidas.workers.dev) on your
computer or phone. Sign in through Cloudflare Access using an authorized email
and its one-time code. This is a private site, not open registration.
Installation is optional; you can use the same app in a normal browser.

1. Open the link above in Chrome or Safari.
2. Enter your authorized email, check your inbox for the sign-in code, and enter
   it on the sign-in page. Check spam if the message does not arrive.
3. Open **Library** to find your sources, **Feed** to study, and **Review** to
   answer questions. Use the same authorized email on your other devices.

If you see an access-denied page, contact the site owner. Creating a GitHub or
Cloudflare account does not grant access to this app.

### Desktop

In Chrome on Windows, macOS or Linux, open the signed-in site, then use the
address-bar install icon or **Menu → Cast, save, and share → Install page as app**.
Confirm and open Resonance from your app launcher. If installation is unavailable,
bookmark the site instead. Menu wording varies by browser/version.
[Chrome's official guide](https://support.google.com/chrome/answer/9658361?hl=en&co=GENIE.Platform%3DDesktop).

### Android

1. Open the live URL in Chrome and sign in, outside an embedded messaging browser.
2. Choose **Menu → Install and create shortcut → Install**. Some versions show
   **Install app** or **Add to Home screen**.
3. Launch the Resonance icon; sign in again if that app context asks you to.
4. Open **Settings** to choose appearance, motion and sound.

No APK or Play Store package is required: this is the approved home-screen web
app. [Chrome's Android guide](https://support.google.com/chrome/answer/9658361?hl=en&co=GENIE.Platform%3DAndroid).

### iPhone and iPad

Open the live URL in Safari, sign in, then choose **Share → Add to Home Screen**.
Enable **Open as Web App** if offered, then tap **Add**. Launch the new icon;
its login/storage context may differ from the Safari tab.
[Apple's guide](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios).
These are platform instructions; physical iPhone/iPad installation and push
delivery have not been acceptance-tested for this release.

### Turn a source into learning cards

1. In **Discover**, find a source and choose **Add to Library**. For a private
   file, use **Library → Upload a private document** and confirm your permission
   to process it.
2. Choose **Extract knowledge points** when offered. The app opens the matching
   source card in **Library**.
3. While processing, that card refreshes every minute. It shows the current
   page/link and section when available, extracted knowledge, and the number of
   generated quiz questions. Leave Library open to watch updates; processing
   runs on the server even if you close the browser.
4. To stop, choose **Cancel processing** and confirm. This removes knowledge
   points, quizzes and associated images produced by that processing run.
5. Once ready, study a five-card batch in **Feed**, choose **Mark batch studied**,
   and answer its paired questions in **Review**. At least five eligible
   knowledge-and-quiz pairs are needed for a batch.

Multiple-choice and exact text answers use the saved answer key. Other text
answers pass when the Jev decision model gives them at least 70% probability of
being correct. A paired question requires its choice and all blanks to pass.
If the grading service is unavailable, the answer stays pending; try again later.
**See more often** moves a knowledge point to a shorter recall interval;
**See less often** moves it to a longer one and informs future extraction.

### Login and data

Cloudflare admin login is separate from Resonance login. Do not share codes.
New devices, cleared cookies, sign-out or session expiry can require a new code.

Hosted sources, knowledge and review records belong to the authenticated server
account. Appearance and reminder enrollment are browser/device-specific.
Local-demo IndexedDB records are separate: **Library → Export** exports local
data, not a complete backup of your hosted account. Clearing browser data can erase local
study/settings and notification enrollment. **Erase local data** does not erase
server records; do not use it as an update troubleshooting shortcut.

### Notifications

Reminders are configured for Android Chrome. Installing the app does not schedule notifications.
Choose **Settings → Enable on this device**,
select a local time, allow notifications and save. **Skip today** suppresses one
day; completed study/review can suppress a reminder too. Choose **Test notification**
and check your notification tray, then tap the notification to open the app.
To test delivery while closed, save a time a few minutes ahead and return to your
home screen without force-stopping Chrome. If you already completed today's
learning, the scheduled reminder is suppressed. Restore your preferred time after
the check. No reinstall is needed; reopen the app online if Settings looks stale.
Check site/browser and OS permissions if notifications stop. Revisit settings
after a timezone change. Delivery is best-effort, not an exact alarm; physical
Android test-push delivery has been confirmed; scheduled and source-event delivery
still need your device check. iOS delivery remains unverified.

The same device opt-in also sends one alert when a source's knowledge and quizzes
are ready, or when permission, an upload or a processing retry needs your action.
There is no separate scraping-complete alert. Source alerts open Library and
omit source titles from the lock screen. **Skip today** affects only daily
reminders; disabling notifications turns off both kinds. Existing completed
sources do not receive backfilled alerts.

### Updates and offline use

Reload/reopen online after a release. The service worker caches the app shell,
not a full offline hosted service: search, extraction, grading, synchronization
and push need connectivity. Local fixture study is separate. If an app looks
stale, close other Resonance tabs and reopen online before considering any cache
reset. Installation does not bypass Cloudflare Access.

## Run the local demo

This is a sample version for learning how the screens work. It does not provide
the hosted search, extraction, image processing, AI grading or notifications.
Its records stay in the browser on that computer and do not sync to your phone.
Use the live app above for those features. No API keys are needed for the demo.

### 1. Install the tools once

- Install **Node.js LTS** from [nodejs.org](https://nodejs.org/en/download).
  Keep the installer's default options; it includes `npm`.
- Install **Deno 2** using the instructions for your operating system at
  [deno.com](https://docs.deno.com/runtime/getting_started/installation/).
- Install **Python 3** from [python.org](https://www.python.org/downloads/).
  On Windows, enable the installer's **Add Python to PATH** option if offered.

Close and reopen your terminal after installation. On Windows, open
**PowerShell** from Start; on macOS, open **Terminal** from Applications →
Utilities; on Linux, open your terminal application.

### 2. Download the project

Open the [GitHub project](https://github.com/leonidasiy/Personal-Knowledge-Platform),
choose **Code → Download ZIP**, then extract the ZIP to a folder you can find.
Open that extracted folder: it should contain `SETUP.md`, `deno.json` and
`package.json` directly, rather than another ZIP or outer folder.

In your terminal, type `cd ` (with a space), then the full folder path in quotes,
and press Enter. For example, replace the path below with your own:

```sh
cd "/path/to/Personal-Knowledge-Platform-main"
```

On Windows a path might be `"C:\Users\YourName\Downloads\Personal-Knowledge-Platform-main"`.
On macOS it might be `"/Users/YourName/Downloads/Personal-Knowledge-Platform-main"`.

### 3. Build and open it

Copy these commands into that terminal **one at a time**, pressing Enter and
waiting for each to finish:

```sh
npm ci
deno task build
deno task serve
```

The first two commands download dependencies and build the app. The last stays
running: leave that terminal open, then open
[http://localhost:4173](http://localhost:4173) in your browser.
If Windows says `python3` was not found, use this instead of `deno task serve`:

```sh
python -m http.server 4173 --directory dist
```

To stop the demo, return to the terminal and press **Ctrl+C**. To start it another
day, open a terminal in the same folder and run `deno task serve` again (or the
Windows command above). You only need to rebuild after changing/updating files.

### Common setup problems

| What you see | What to do |
| --- | --- |
| `npm`, `deno` or Python not found | Install the matching tool, then reopen your terminal. |
| `package.json` or `deno.json` not found | Use `cd` to enter the extracted project folder. |
| Build/download failure | Check your internet connection; keep the error message if you need help. Do not continue to the server step until the build succeeds. |
| Port 4173 already in use | Stop an earlier demo terminal with Ctrl+C. |
| The local app has no hosted source processing | This is expected in the sample demo. Open the live URL for the full service. |

To use Resonance on your phone, open the **live HTTPS URL**, then follow the
Android or iPhone instructions above. `localhost` on a phone points to that
phone, so the computer's demo address will not work there.

Running your own full online service requires separate Cloudflare resources,
access policies and provider credentials. The repository's `wrangler.jsonc`
targets the existing owner's service; it is not a ready-to-deploy configuration
for another account. Ordinary users only need the live link and an authorized
email.
