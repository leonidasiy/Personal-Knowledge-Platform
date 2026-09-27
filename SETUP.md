# Setup and everyday use

## Use the live app

Open [Resonance](https://resonance-discovery.lirenleonidas.workers.dev) on your
computer or phone. Sign in through Cloudflare Access using an authorized email
and its one-time code. This is a private site, not open registration.
Installation is optional; you can use the same app in a normal browser.

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

### Login and data

Cloudflare admin login is separate from Resonance login. Do not share codes.
New devices, cleared cookies, sign-out or session expiry can require a new code.

Hosted sources, knowledge and review records belong to the authenticated server
account. Appearance and reminder enrollment are browser/device-specific.
Local-demo IndexedDB records are separate: **Library → Export** exports local
data, not a complete backup of your hosted account. Clearing browser data can erase local
study/settings and notification enrollment. **Erase local data** does not erase
server records; do not use it as an update troubleshooting shortcut.

### Daily reminders

Push delivery is not activated. Installing the app does not schedule notifications.
Once reminders are available, choose **Settings → Enable on this device**,
select a local time, allow notifications and save. **Skip today** suppresses one
day; completed study/review can suppress a reminder too. A test send checks the
send path; seeing it on the actual device is required to prove delivery.
Check site/browser and OS permissions if notifications stop. Revisit settings
after a timezone change. Delivery is best-effort, not an exact alarm; physical
Android/iOS notification delivery remains unverified.

### Updates and offline use

Reload/reopen online after a release. The service worker caches the app shell,
not a full offline hosted service: search, extraction, grading, synchronization
and push need connectivity. Local fixture study is separate. If an app looks
stale, close other Resonance tabs and reopen online before considering any cache
reset. Installation does not bypass Cloudflare Access.
