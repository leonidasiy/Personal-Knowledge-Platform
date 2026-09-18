// @ts-check

import { validateSourceRightsProfile } from "../src/features/source-library/rights-profile.js";

/** @import { SourceRightsProfile } from "../src/features/source-library/rights-profile.js" */

const openMusicTheory = Object.freeze({
  profileId: "open-music-theory-cc-by-sa-4.0-v1",
  canonicalRootUrl: "https://viva.pressbooks.pub/openmusictheory/",
  origin: "https://viva.pressbooks.pub/",
  access: "public",
  attributionText: "Open Music Theory, copyright © 2023 by Mark Gotham, Kyle Gullings, Chelsey Hamm, Bryn Hughes, Brian Jarvis, Megan Lavengood, and John Peterson; licensed under CC BY-SA 4.0 International, except where otherwise noted.",
  robotsUrl: "https://viva.pressbooks.pub/robots.txt",
  evidence: Object.freeze([
    { capability: "copyright", outcome: "allowed", reference: "https://viva.pressbooks.pub/openmusictheory/front-matter/introduction/", observedAt: "2026-08-17T00:00:00.000Z", expiresAt: null },
    { capability: "licence", outcome: "allowed", reference: "https://viva.pressbooks.pub/openmusictheory/front-matter/introduction/", observedAt: "2026-08-17T00:00:00.000Z", expiresAt: null },
    { capability: "terms", outcome: "allowed", reference: "https://viva.pressbooks.pub/openmusictheory/front-matter/introduction/", observedAt: "2026-08-17T00:00:00.000Z", expiresAt: null },
    { capability: "access", outcome: "allowed", reference: "https://viva.pressbooks.pub/openmusictheory/", observedAt: "2026-08-17T00:00:00.000Z", expiresAt: null },
    { capability: "storage", outcome: "allowed", reference: "https://creativecommons.org/licenses/by-sa/4.0/", observedAt: "2026-08-17T00:00:00.000Z", expiresAt: null },
    { capability: "display", outcome: "allowed", reference: "https://creativecommons.org/licenses/by-sa/4.0/", observedAt: "2026-08-17T00:00:00.000Z", expiresAt: null },
    { capability: "transformation", outcome: "allowed", reference: "https://creativecommons.org/licenses/by-sa/4.0/", observedAt: "2026-08-17T00:00:00.000Z", expiresAt: null },
    { capability: "attribution", outcome: "allowed", reference: "https://viva.pressbooks.pub/openmusictheory/front-matter/introduction/", observedAt: "2026-08-17T00:00:00.000Z", expiresAt: null },
    { capability: "origin", outcome: "allowed", reference: "https://viva.pressbooks.pub/openmusictheory/", observedAt: "2026-08-17T00:00:00.000Z", expiresAt: null },
  ]),
});

const validated = validateSourceRightsProfile(openMusicTheory);
const validatedProfile = validated.ok
  ? validated.value
  : (() => { throw new TypeError(`Open Music Theory rights profile is invalid: ${validated.error.field}`); })();

/** @param {string} canonicalUrl @returns {SourceRightsProfile | null} */
export function sourceRightsProfileFor(canonicalUrl) {
  if (canonicalUrl === validatedProfile.canonicalRootUrl) return validatedProfile;
  return null;
}

export {};
