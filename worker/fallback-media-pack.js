// @ts-check

/**
 * The manifest intentionally activates only the two selected local images.
 * Other files in assets/fallback-media remain user-owned and are not served
 * until their provenance metadata is reviewed and added to this pack.
 */
export const FALLBACK_MEDIA_PACK = Object.freeze([
  Object.freeze({
    id: "fallback-sheet-music",
    url: "/assets/fallback-media/Heungsoon%20Sheet%20Music.jpg",
    alt: "Sheet music with a pen resting across the page",
    creator: "User-provided image; creator metadata not supplied",
    licence: "User-provided; verify the original licence before hosted deployment",
    attribution: "User-provided fallback image; original attribution metadata is pending",
    mediaType: "image/jpeg",
    approved: true,
  }),
  Object.freeze({
    id: "fallback-headphones",
    url: "/assets/fallback-media/Headphones%20Music%20Image.jpg",
    alt: "Red headphones on a softly lit surface",
    creator: "User-provided image; creator metadata not supplied",
    licence: "User-provided; verify the original licence before hosted deployment",
    attribution: "User-provided fallback image; original attribution metadata is pending",
    mediaType: "image/jpeg",
    approved: true,
  }),
]);

export {};
