# Dependency security assessment

Scoped assessment on 2026-10-18: npm dependencies used by the current application,
the eight reported high-severity alerts, their source paths, and available fixes.
This is not a penetration test or an audit of every application feature.

## Results

The original eight alerts included parent packages affected transitively. They
were not eight independent exploitable bugs. `npm audit` reported **zero critical**
findings. The fixes below reduce the report to **three high / zero critical**.

| Root dependency | Risk and application exposure | Action |
| --- | --- | --- |
| `ip-address` 10.2.0 | Ambiguous IPv4 octets and incorrect address classification can defeat network restrictions in affected callers. It enters through Puppeteer's Node proxy chain; the application's acquisition policy uses its own address validation. | Updated to 10.7.4. Regression checks reject leading-zero octets and recognize the full IPv6 link-local range. |
| `basic-ftp` 5.3.1 | A malicious directory listing can stall the Node event loop. It enters through optional FTP retrieval of proxy configuration. The application does not configure FTP or proxy PAC fetching. | Scoped `get-uri` dependency override to patched 6.2.3. Checked the API used by `get-uri`, a normal listing and the adversarial listing in a subprocess with a hard deadline. |
| `extract-zip` 2.0.1 | Malicious ZIP symlink entries can create links/write files outside the extraction directory. No patched release is published. | Retained with the reachability limits below; do not use it to extract untrusted archives. |

Sources: [IP parser advisory](https://github.com/advisories/GHSA-mwp4-54f8-5fhr),
[FTP parser advisory and patch](https://github.com/advisories/GHSA-c475-qrg2-pj4r),
[ZIP symlink advisory](https://github.com/advisories/GHSA-jmr9-qjv8-65gv) and
[ZIP arbitrary-write advisory](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3).

## Why three alerts remain

They are `extract-zip` plus its parents `@puppeteer/browsers` and
`@cloudflare/puppeteer`. The vulnerable code is in Puppeteer's **Node browser
installation** tools. The application imports Cloudflare's remote-browser
entry point for its legacy public-page capture. That import graph and the
deployed Worker bundle exclude `@puppeteer/browsers` and `extract-zip`.
Computer mode uses the same remote-browser import but supplies its own supported
Firecrawl capture; acquisition does not use this ZIP installer. No learner upload
or supplied website is passed to `extract-zip` by the application.

A controlled synthetic ZIP reproduced the outside-directory write in a
disposable temporary fixture. All test paths were contained within that fixture
and removed afterward. The 371-source Worker bundle contained none of the
vulnerable dependency modules or Node installer/launcher modules.

The remaining advisory is serious if that dependency is used to extract an
attacker-controlled ZIP. No such reachable application path was found. This
reduces current exposure; it does not fix the upstream package or make it safe
for other uses. Reassess before adding browser-installation/archive features or
changing Puppeteer's import path.

`npm audit fix --force` proposes downgrading Cloudflare Puppeteer to 0.0.11. This
is not a patched current release and risks breaking its remote-browser contract.
The latest Cloudflare package still depends on the affected browser installer;
upgrading it alone does not resolve the ZIP advisories. No audit suppression or
fake patched version is used. Upgrade when a compatible upstream fix is available.

Recheck your own checkout with `npm ci` and `npm audit`; advisories and available
patches change. The scoped FTP override should be removed when `get-uri` itself
accepts an adequately patched version. Keep `package-lock.json` committed so
fresh installations use the reviewed dependency graph.
