// @ts-check
import { SUBJECTS } from "./public.js";
/** @import { AudioCue } from "../experience/contracts.js" */
// Authored presentation for the closed v1 taxonomy, never LLM-produced markup.
// Paths are intentionally small: grid, pixels, orbit, bonds, leaf, contours,
// compass, mechanism, pulse, connections, motion, columns, scales, community,
// growth, steps, dialogue, writing, inquiry, frame, waveform, and tools.
const paths = [
  "M4 8h24M4 16h24M4 24h24M8 4v24M16 4v24M24 4v24",
  "M5 5h8v8H5zM19 5h8v8h-8zM5 19h8v8H5zM19 19h8v8h-8z",
  "M2 16a14 6 0 1 0 28 0a14 6 0 1 0-28 0M16 2a6 14 0 1 0 0 28a6 14 0 1 0 0-28M15 15h2v2h-2z",
  "M7 7l18 18M7 25L25 7M3 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0M21 25a4 4 0 1 0 8 0a4 4 0 1 0-8 0",
  "M5 27C1 10 12 3 28 4C29 19 21 29 5 27M5 27L25 7M13 19v-8M13 19h8",
  "M2 22C10 1 22 31 30 10M2 15C10-6 22 24 30 3M2 29C10 8 22 38 30 17",
  "M16 2v28M2 16h28M24 8L19 19L8 24L13 13z",
  "M4 8h24v16H4zM8 4v24M16 4v24M24 4v24M4 16h24",
  "M2 17h7l4-11l6 21l4-10h7",
  "M6 8L16 16L26 6M16 16L24 27M16 16L5 26M12 16a4 4 0 1 0 8 0a4 4 0 1 0-8 0",
  "M3 7l10 9L3 25M13 7l10 9l-10 9M23 7l7 9l-7 9",
  "M3 10L16 3L29 10zM5 28h22M8 13v12M16 13v12M24 13v12",
  "M16 3v25M4 28h24M4 9h24M7 9L2 20h10zM25 9l-5 11h10z",
  "M12 8a4 4 0 1 0 8 0a4 4 0 1 0-8 0M7 28v-5a9 9 0 0 1 18 0v5M2 16h4M26 16h4",
  "M4 27V17h5v10M13 27V11h5v16M22 27V4h5v23",
  "M3 28v-7h8v-7h9V7h9M23 3h6v6",
  "M3 5h20v15H10l-7 6zM25 12h5v17l-6-4h-9",
  "M5 3h22v26H5zM9 9h14M9 15h14M9 21h9",
  "M5 16a11 11 0 1 0 22 0a11 11 0 1 0-22 0M12 12a4 4 0 0 1 8 0c0 4-4 2-4 7M16 23v1",
  "M2 11V2h9M21 2h9v9M30 21v9h-9M11 30H2v-9M9 23l7-14l7 14z",
  "M3 13v6M8 7v18M13 3v26M18 9v14M23 5v22M28 12v8",
  "M5 26L24 7M20 3l9 9M3 21l8 8M3 3l9 9M20 20l9 9",
];
/** @param {string|null} id @returns {{label:string,hue:number,turn:number,path:string,cue:AudioCue}|null} */
export function subjectPresentation(id) {
  const index = SUBJECTS.findIndex(subject => subject.id === id);
  if (index < 0) return null; // Explicit unclassified/legacy neutral presentation.
  return { label: SUBJECTS[index].label, hue: (index * 137.5 + 215) % 360, turn: (index % 2 ? -1 : 1) * (index % 5 + 2), path: paths[index],
    cue: { frequencyHz: 240 + index * 23, durationSeconds: 0.055 + (index % 4) * 0.018, peakGain: 0.016, oscillatorType: index % 2 ? "triangle" : "sine" } };
}
