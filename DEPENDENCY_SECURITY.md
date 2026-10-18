# Dependency security assessment

Scoped assessment on 2026-10-18: npm dependencies used by the current application,
the original eight high-severity alerts, their source paths, and available fixes.
This is not a penetration test or an audit of every application feature.

## Current result: zero audit vulnerabilities

The application does not use `extract-zip`. It entered through the Node browser
installer in `@puppeteer/browsers` 2.2.4, a dependency of Cloudflare Puppeteer.
The app still uses **Cloudflare Puppeteer’s remote browser client** for URL/PDF
capture, so removing the entire Cloudflare client would remove working behavior.

A scoped npm override now uses upstream `@puppeteer/browsers` **3.2.5** underneath
`@cloudflare/puppeteer` **1.1.0**. The Cloudflare client itself remains unchanged.
The newer helper no longer depends on `extract-zip`, and its release includes
ZIP symlink-chain and build-ID traversal fixes.
[Upstream release](https://github.com/puppeteer/puppeteer/releases/tag/browsers-v3.2.5).

This removes `extract-zip`, `basic-ftp`, `ip-address`, `get-uri`, `proxy-agent`
and `pac-proxy-agent` from the application’s lockfile and fresh installations.
The earlier FTP-only override is superseded and removed. `npm audit` now reports
**zero vulnerabilities**, including zero high and zero critical findings.
No advisory suppression or fake patched package is used.

## Compatibility and maintenance

This is a deliberate major-version override of an **unused Node helper**. It is
validated for this application's remote-browser entry point, not a blanket
compatibility claim for Cloudflare Puppeteer's internal Node launchers, local
browser installation or archive tools. Reassess the override before adding those
features or changing the Puppeteer import path. Node.js 24 or newer, already
required by the setup guides, satisfies the helper's Node >=22.12 requirement.

Verification covers the installed dependency graph, the unchanged Cloudflare
client's remote launch-binding request, URL/PDF capture and original-image
handling, local backend startup/pipeline, type-checking and production bundling.
The Worker bundle excludes the browser-helper installer and archive modules.
The remote-binding test uses a synthetic response and consumes no browser credits.
Actual hosted checks are read-only and preserve learner records.

Keep `package-lock.json` committed and use `npm ci` so fresh installations use
this dependency graph. When Cloudflare updates its own declared helper version,
recheck whether this override is still needed. Re-run `npm audit` after dependency
changes; a clean report reflects current advisories, not proof of universal safety.

## Original findings and investigation

The original eight alerts included transitive parent packages rather than eight
independent exploitable bugs. The first repair reduced them to three high alerts;
this follow-up removes that remaining vulnerable dependency chain entirely.

| Original root | Risk and assessment | Final action |
| --- | --- | --- |
| `ip-address` 10.2.0 | Ambiguous IPv4 octets and incorrect address classification can defeat network restrictions in affected callers. The application's acquisition policy uses separate address validation. | Initially updated to 10.7.4; now absent with the unused proxy chain. |
| `basic-ftp` 5.3.1 | Malicious directory listings can stall the Node event loop. The application does not configure FTP retrieval of proxy configuration. | Initially overrode to 6.2.3; now absent and the override removed. |
| `extract-zip` 2.0.1 | Malicious symlink entries can write outside the extraction directory. No patched `extract-zip` release was published. | Removed through the browser-helper dependency replacement. |

A controlled synthetic ZIP reproduced the outside-directory write. All paths
were contained within a disposable fixture and removed afterward. Source and
bundle analysis found no application path passing learner uploads or supplied
websites to that installer. Removing it also eliminates the dormant exposure.

Sources: [IP parser advisory](https://github.com/advisories/GHSA-mwp4-54f8-5fhr),
[FTP parser advisory](https://github.com/advisories/GHSA-c475-qrg2-pj4r),
[ZIP symlink advisory](https://github.com/advisories/GHSA-jmr9-qjv8-65gv) and
[ZIP arbitrary-write advisory](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3).

The audit's proposed downgrade of the Cloudflare client to 0.0.11 was not used.
Updating Cloudflare's client alone to its then-latest 1.4.0 would still select
the affected helper 2.2.4. The scoped override preserves the current remote client
and avoids an unrelated client migration.
