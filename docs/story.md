# Story: build edits from text, across many takes

Owner: Dima. Date: 24 Nov 2026. Status: v1 spec, being built on `feat/story` (DIMA-2054).

## Why

Dima, 24 Nov 2026: "I cannot see text easily. There's no text-based editor that I can look at, select the best
moments, and tell you, 'Okay, I want this in there.'" and "I'm not just going to use it for only that: building a
story. I also want to use it for the other short forms, a lot of different takes."

Our footage is interviews: several people answer the same questions, each in several takes, on more than one camera.
The story lives in the words. Today FrameFlow shows words only for clips already on the timeline (the Words panel),
and only a Gemini transcript makes words at all. Story fixes both: every take's words side by side, select what
should be in, get an ordered list, put it on the timeline in one step. A person and an agent work on the same lists.

## What it is

1. **Words for every clip, without Gemini.** Two new ways to get a word-level transcript:
   - **Local engine (whisper.cpp):** `whisper-cli` on this Mac, model `ggml-large-v3-turbo`, word timestamps with DTW.
     Free, offline. Chosen in Settings like any other transcript model (`local-whisper`). Output goes through the same
     stitch, onset-snap and timing-health steps as Gemini's, so captions, pieces and health keep working.
   - **Import:** a word-level transcript file for a clip: whisper.cpp JSON (`-oj` with `-ml 1`, and the catalogue form
     `{"words":[{text,start,end}]}`), and SRT or VTT (sentence-level only). Media panel: "Import transcript…";
     MCP: `import_transcript`.
2. **Stories.** A project holds any number of stories (one per short form). A story is an ordered list of picks.
   A pick is a run of spoken words from one clip: `{id, assetId, in, out, wordIn, wordOut, speaker, take, text, note}`
   with `in`/`out` the raw word edges in SOURCE seconds. Stories live on the editor document, saved with it and kept in
   revision snapshots, outside the timeline's undo diff (like markers).
3. **The Story view.** A wide view opened from the editor's top bar (the left rail is too narrow for takes side by
   side):
   - Left: every clip's transcript as readable paragraphs, grouped by speaker, with clip name and take. Search across
     all of them. Words are text you select: drag across words (or click the first, shift-click the last), then
     "Add" (or press A). Words already in the open story are underlined.
   - Right: the open story as cards: who, the words, length. Drag to reorder, play a card, play the whole story in
     order, trim a card by clicking a new first or last word, delete, add a note. Story picker and "New story" on top.
   - A small preview player plays the pick (the clip's own file) so you hear it before it goes in.
   - "Put on timeline": replaces (or appends to) the main track with the story's picks, in order.
4. **Placing a pick** adds handles so a word never clips: `in` moves back to halfway into the pause before the first
   word (at most 0.25 s), `out` forward to halfway into the pause after the last word (at most 0.35 s), never past a
   neighbouring word. Then `addClips` (or `placeMulticam` when the clip belongs to a camera group, angle kept).
5. **Picks files.** Import and export a story as JSON, shared with the rescript fork (DIMA-2055) and the compositor:
   `{"version":1,"name","fps","picks":[{"source": <absolute original path>, "in","out","speaker","take","text","note"}]}`,
   extra keys allowed. Default folder `~/Studio/runs/<run>/picks/`. A pick's `source` is matched to an imported asset by
   path, then by file name.
6. **MCP**, so an agent and a person share the lists: `get_stories`, `set_story` (create or replace a story; picks by
   asset and source seconds, or by quoted words from search_moments), `place_story`, `import_transcript`,
   `get_words` (a clip's words in source seconds, the data the Story view shows).

## Not in v1

Multi-angle choice per pick inside the Story view (the angle is kept if the clip is a camera group member), speaker
diarisation for single-file multi-speaker clips (speaker comes from the clip label), forced alignment beyond DTW,
editing transcript text.

## Done when

On this Mac: the 23 Nov interview clips get word transcripts locally (or by import from the catalogue), the Story view
shows all four DJs' answers, Dima builds Q1 by selecting text, "Put on timeline" lays it out with no clipped word
(checked by re-transcribing the result), an agent reads and writes the same story over MCP, and the tests pass.
