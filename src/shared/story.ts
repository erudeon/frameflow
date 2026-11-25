/**
 * Story: build an edit from spoken words across many takes (docs/story.md).
 *
 * A story is an ordered list of picks; a pick is a run of spoken words from one clip, kept as the raw word edges in
 * SOURCE seconds. Placing a pick adds handles so no word is clipped. Pure and dependency-free so the rules that decide
 * where a cut lands are tested directly.
 */

export interface Word {
	text: string
	/** Seconds in the source file. */
	start: number
	end: number
}

export interface StoryPick {
	id: string
	assetId: string
	/** Raw word edges in SOURCE seconds (no handles). */
	in: number
	out: number
	/** Index of the first and last word in the clip's word list when the pick was made. */
	wordIn?: number
	wordOut?: number
	speaker?: string
	take?: string
	text: string
	note?: string
	/**
	 * Camera groups only. `angle` locks the whole pick to one camera (its 1-based number or name); `cuts` cut to other
	 * cameras inside the pick, each from `at` (SOURCE seconds of this pick's clip, snapped to the word starting there).
	 * Cuts win over the lock, the lock over place_story's camera mode.
	 */
	angle?: string | number
	cuts?: PickCut[]
}

/** From `at` (SOURCE seconds of the pick's clip) the pick shows `angle` (a camera's 1-based number or name). */
export interface PickCut { at: number; angle: string | number }

export interface Story {
	id: string
	name: string
	picks: StoryPick[]
	/** Bumped on every change; set_story refuses a write made against an older rev. */
	rev?: number
	/** The last few versions of the picks, newest first, so a bad write can be undone. */
	history?: { at: number; by: 'person' | 'agent'; picks: StoryPick[] }[]
	createdAt?: number
	updatedAt?: number
}

/** Who is on a clip and which take it is: set once per clip, shown on every pick. */
export interface ClipTag { speaker?: string; take?: string; star?: boolean; group?: string }

/** The shared picks file (FrameFlow Story, the rescript fork, the compositor). Extra keys are allowed and ignored. */
export interface PicksFile {
	version?: number
	name: string
	fps?: number
	picks: { source: string; in: number; out: number; speaker?: string; take?: string; text?: string; note?: string; [k: string]: unknown }[]
	[k: string]: unknown
}

// ---------------------------------------------------------------- reading word transcripts

const clean = (t: string) => t.replace(/\s+/g, ' ').trim()

/**
 * Words from a transcript file in any of the forms we meet:
 * - whisper.cpp `-oj` (`{transcription:[{text, offsets:{from,to}}]}`), ideally made with `-ml 1` (one word per entry);
 *   longer entries are split into words with times shared out by length;
 * - the catalogue / ElevenLabs form `{words:[{text,start,end,type?}]}` (spacing entries skipped);
 * - FrameFlow's own `TranscriptItem[]` with `words`.
 */
export function parseWordTranscript(json: unknown): Word[] {
	const out: Word[] = []
	const push = (text: string, start: number, end: number) => {
		const t = clean(text)
		if (!t || !Number.isFinite(start) || !Number.isFinite(end)) return
		out.push({ text: t, start, end: Math.max(end, start) })
	}
	const splitInto = (text: string, start: number, end: number) => {
		const parts = clean(text).split(' ').filter(Boolean)
		if (parts.length <= 1) return push(text, start, end)
		const total = parts.reduce((n, p) => n + p.length, 0) || 1
		let t = start
		for (const p of parts) {
			const d = ((end - start) * p.length) / total
			push(p, t, t + d)
			t += d
		}
	}
	const j = json as any
	if (j && Array.isArray(j.transcription)) {
		for (const x of j.transcription) {
			const from = x?.offsets?.from, to = x?.offsets?.to
			if (typeof from === 'number' && typeof to === 'number') splitInto(String(x.text ?? ''), from / 1000, to / 1000)
		}
	} else if (j && Array.isArray(j.words)) {
		for (const x of j.words) {
			if (x?.type && x.type !== 'word') continue
			push(String(x.text ?? ''), Number(x.start), Number(x.end))
		}
	} else if (Array.isArray(j)) {
		for (const item of j) for (const w of item?.words ?? []) push(String(w.text ?? ''), Number(w.start), Number(w.end))
	}
	// whisper.cpp sometimes emits a punctuation-only token as its own word: glue it to the word before
	const merged: Word[] = []
	for (const w of out.sort((a, b) => a.start - b.start)) {
		if (/^[.,!?;:…"')\]]+$/.test(w.text) && merged.length) {
			const prev = merged[merged.length - 1]
			prev.text += w.text
			prev.end = Math.max(prev.end, w.end)
		} else merged.push({ ...w })
	}
	return merged
}

/** Words grouped into readable lines: break at sentence ends, pauses, or every `maxWords`. */
export function wordsToLines(words: Word[], opts: { maxGapSec?: number; maxWords?: number } = {}): { start: number; end: number; first: number; last: number; text: string }[] {
	const maxGap = opts.maxGapSec ?? 0.7, maxWords = opts.maxWords ?? 24
	const lines: { start: number; end: number; first: number; last: number; text: string }[] = []
	let first = 0
	for (let i = 0; i < words.length; i++) {
		const next = words[i + 1]
		const end = /[.?!]$/.test(words[i].text) || !next || next.start - words[i].end >= maxGap || i - first + 1 >= maxWords
		if (end) {
			lines.push({ start: words[first].start, end: words[i].end, first, last: i,
				text: words.slice(first, i + 1).map((w) => w.text).join(' ') })
			first = i + 1
		}
	}
	return lines
}

// ---------------------------------------------------------------- making and placing picks

let seq = 0
export const newPickId = () => `pk_${Date.now().toString(36)}_${(seq++).toString(36)}`

/** A pick from word indexes [a, b] (inclusive, any order) of a clip's words. */
export function pickFromWords(assetId: string, words: Word[], a: number, b: number, meta: { speaker?: string; take?: string } = {}): StoryPick | null {
	const i0 = Math.max(0, Math.min(a, b)), i1 = Math.min(words.length - 1, Math.max(a, b))
	if (!words.length || i0 > i1) return null
	return { id: newPickId(), assetId, in: words[i0].start, out: words[i1].end, wordIn: i0, wordOut: i1,
		text: words.slice(i0, i1 + 1).map((w) => w.text).join(' '), ...meta }
}

/** Word indexes a pick covers, from its stored indexes when they still match, else from its times. */
export function pickWordRange(pick: StoryPick, words: Word[]): [number, number] | null {
	if (pick.wordIn != null && pick.wordOut != null && words[pick.wordIn] && words[pick.wordOut]
		&& Math.abs(words[pick.wordIn].start - pick.in) < 0.05 && Math.abs(words[pick.wordOut].end - pick.out) < 0.05) {
		return [pick.wordIn, pick.wordOut]
	}
	let a = -1, b = -1
	for (let i = 0; i < words.length; i++) {
		const mid = (words[i].start + words[i].end) / 2
		if (mid >= pick.in - 0.02 && mid <= pick.out + 0.02) { if (a < 0) a = i; b = i }
	}
	return a < 0 ? null : [a, b]
}

export const HANDLE = { lead: 0.08, tail: 0.04, longGap: 0.6, endPad: 0.08, noSilenceTail: 0.7, snapBack: 0.25 }

/**
 * Source in/out to place a pick so no word clips. Rule (Fable review, 24 Nov): whisper word STARTS are reliable, its
 * word ENDS are not (24 Nov: "one." ended at 143.24 by whisper, 143.8 by the audio), so no edge is taken from a word end.
 * - in: just before the first word starts (0.08 s, less when the word before runs right into it), moved back into
 *   the quiet before it when the measured silences show one within 0.25 s.
 * - out: just before the NEXT word starts; when there is no next word, or the pause before it is long, where the audio
 *   goes quiet after the last word (the clip's measured silences), else 0.7 s after the last word's end.
 */
export function placeRange(pick: StoryPick, words: Word[], sourceDuration?: number,
	silences?: { start: number; end: number }[]): { in: number; out: number } {
	const r = pickWordRange(pick, words)
	if (!r) return { in: pick.in, out: pick.out }
	const [a, b] = r
	const first = words[a], last = words[b], prev = words[a - 1], next = words[b + 1]
	const lead = prev ? Math.min(HANDLE.lead, Math.max(0.02, first.start - prev.end)) : HANDLE.lead
	let inT = first.start - lead
	const quietBefore = silences?.filter((q) => q.end >= first.start - HANDLE.snapBack && q.end <= first.start + 0.02).pop()
	if (quietBefore) inT = Math.min(inT, Math.max(quietBefore.start, quietBefore.end - 0.04))
	if (prev) inT = Math.max(inT, prev.start + 0.05)
	const longPause = !next || next.start - last.end > HANDLE.longGap
	let outT: number
	if (!longPause) outT = next!.start - HANDLE.tail
	else {
		const quietAfter = silences?.find((q) => q.start >= last.start + 0.1 && q.end > last.start + 0.15)
		outT = quietAfter ? quietAfter.start + HANDLE.endPad : Math.max(last.end, last.start + 0.12) + HANDLE.noSilenceTail
		if (next) outT = Math.min(outT, next.start - HANDLE.tail)
	}
	outT = Math.max(outT, last.start + 0.12)
	inT = Math.max(0, inT)
	if (sourceDuration != null) outT = Math.min(outT, sourceDuration)
	return { in: round3(inT), out: round3(outT) }
}

const round3 = (x: number) => Math.round(x * 1000) / 1000

// ---------------------------------------------------------------- cutting between cameras

/**
 * How "cut between cameras at pauses" chooses its cuts: a cut lands just before a word that follows a pause, never
 * leaving a shot shorter than minShotSec (or a last shot shorter than lastShotSec).
 */
export const CAMERA_CUTS = { minShotSec: 3, lastShotSec: 2.5, pauseSec: 0.25, lead: 0.06, noSilencePauseSec: 0.35 }

/**
 * Every place inside [range.in, range.out] a pick could cut to another camera: just before a word that follows a
 * pause, in SOURCE seconds, in order. A pause is measured quiet (silences) ending at the word's start; without
 * measurements, a gap between the words of at least 0.35 s (word ends are less sure than starts).
 */
export function pauseCutPoints(words: Word[], range: { in: number; out: number }, silences?: { start: number; end: number }[] | null): number[] {
	const out: number[] = []
	for (let i = 1; i < words.length; i++) {
		const w = words[i], prev = words[i - 1]
		if (w.start <= range.in + 0.05 || w.start >= range.out) continue
		let cut: number | null = null
		if (silences?.length) {
			const q = silences.find((s) => s.end >= w.start - 0.25 && s.end <= w.start + 0.02 && s.start >= prev.start && s.end - s.start >= CAMERA_CUTS.pauseSec)
			if (q) cut = Math.max(q.start, w.start - CAMERA_CUTS.lead)
		} else if (w.start - prev.end >= CAMERA_CUTS.noSilencePauseSec) {
			cut = Math.max(prev.end, w.start - CAMERA_CUTS.lead)
		}
		if (cut != null && cut > range.in) out.push(round3(cut))
	}
	return out
}

/** The pause cuts to make: the earliest that leave every shot at least minShotSec and the last one lastShotSec. */
export function chooseCameraCuts(points: number[], range: { in: number; out: number },
	opts: { minShotSec?: number; lastShotSec?: number } = {}): number[] {
	const min = opts.minShotSec ?? CAMERA_CUTS.minShotSec
	const last = opts.lastShotSec ?? Math.min(min, CAMERA_CUTS.lastShotSec)
	const chosen: number[] = []
	let from = range.in
	for (const p of [...points].sort((a, b) => a - b)) {
		if (p - from >= min - 1e-6 && range.out - p >= last - 1e-6) { chosen.push(p); from = p }
	}
	return chosen
}

// ---------------------------------------------------------------- stories

export function storyDuration(story: Story): number {
	return story.picks.reduce((n, p) => n + Math.max(0, p.out - p.in), 0)
}

export function movePick(story: Story, from: number, to: number): Story {
	const picks = story.picks.slice()
	const [p] = picks.splice(from, 1)
	if (!p) return story
	picks.splice(Math.max(0, Math.min(picks.length, to)), 0, p)
	return { ...story, picks, updatedAt: Date.now() }
}

// ---------------------------------------------------------------- picks files

export interface AssetRef { id: string; name: string; path?: string; duration?: number }

const base = (p: string) => p.split(/[\\/]/).pop()!.toLowerCase().replace(/\.(lrf|proxy\.mp4)$/i, '')
const stem = (p: string) => base(p).replace(/\.[^.]+$/, '')

/**
 * Match a picks-file source to an imported asset: same path; else same file name (or name without extension), and when
 * several assets share it, the one whose length covers the pick. Ambiguous or missing: undefined (the caller reports it).
 */
export function matchAsset(source: string, assets: AssetRef[], pickOut?: number): AssetRef | undefined {
	const exact = assets.find((a) => a.path && a.path === source)
	if (exact) return exact
	for (const key of [base, stem]) {
		let c = assets.filter((a) => (a.path && key(a.path) === key(source)) || key(a.name) === key(source))
		if (c.length > 1 && pickOut != null) c = c.filter((a) => a.duration == null || a.duration >= pickOut - 0.05)
		if (c.length === 1) return c[0]
		if (c.length > 1) return undefined
	}
	return undefined
}

export function storyFromPicksFile(file: PicksFile, assets: AssetRef[]): { story: Story; unmatched: string[] } {
	const unmatched: string[] = []
	const picks: StoryPick[] = []
	for (const p of file.picks ?? []) {
		const a = matchAsset(String(p.source), assets, Number(p.out))
		if (!a) { unmatched.push(String(p.source)); continue }
		picks.push({ id: newPickId(), assetId: a.id, in: Number(p.in), out: Number(p.out), speaker: p.speaker, take: p.take,
			text: String(p.text ?? ''), note: p.note,
			...(typeof p.angle === 'string' || typeof p.angle === 'number' ? { angle: p.angle } : {}),
			...(Array.isArray(p.cuts) ? { cuts: (p.cuts as any[]).filter((c) => c && Number.isFinite(Number(c.at)) && c.angle != null).map((c) => ({ at: Number(c.at), angle: c.angle })) } : {}),
			wordIn: typeof p.wordIn === 'number' ? (p.wordIn as number) : undefined,
			wordOut: typeof p.wordOut === 'number' ? (p.wordOut as number) : undefined })
	}
	return { story: { id: `st_${Date.now().toString(36)}`, name: file.name || 'Imported story', picks, createdAt: Date.now() }, unmatched }
}

export function picksFileFromStory(story: Story, assets: AssetRef[], fps = 25): PicksFile {
	const byId = new Map(assets.map((a) => [a.id, a]))
	return { version: 1, name: story.name, fps, picks: story.picks.map((p) => ({
		source: byId.get(p.assetId)?.path ?? byId.get(p.assetId)?.name ?? p.assetId, in: p.in, out: p.out,
		speaker: p.speaker, take: p.take, text: p.text, note: p.note, id: p.id, wordIn: p.wordIn, wordOut: p.wordOut,
		...(p.angle != null ? { angle: p.angle } : {}), ...(p.cuts?.length ? { cuts: p.cuts } : {}) })) }
}
