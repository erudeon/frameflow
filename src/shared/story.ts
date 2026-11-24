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
}

export interface Story {
	id: string
	name: string
	picks: StoryPick[]
	createdAt?: number
	updatedAt?: number
}

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

export const HANDLE = { preMax: 0.25, postMax: 0.7, minGap: 0.06 }

/**
 * Source in/out to place a pick so no word clips. Word STARTS are the reliable edge (whisper's ends run long or short),
 * so: the cut opens a little before the first word, at most halfway into the pause before it; it closes just before
 * the NEXT word starts (never past it), at most `postMax` after the last word's start-based end.
 */
export function placeRange(pick: StoryPick, words: Word[], sourceDuration?: number,
	silences?: { start: number; end: number }[]): { in: number; out: number } {
	const r = pickWordRange(pick, words)
	if (!r) return { in: pick.in, out: pick.out }
	const [a, b] = r
	const first = words[a], last = words[b], prev = words[a - 1], next = words[b + 1]
	let inT = first.start - HANDLE.preMax
	if (prev) inT = Math.max(inT, (Math.min(prev.end, first.start) + first.start) / 2)   // halfway into the pause, never into the word before
	inT = Math.min(inT, first.start - 0.02)
	// whisper ends a last word early by up to ~0.6 s (24 Nov: "one." 143.24 vs audio 143.8): allow a long tail,
	// and when the clip's measured silences are known, close where the speech actually stops
	let outT = Math.max(last.end, last.start + 0.12) + HANDLE.postMax
	const quiet = silences?.find((s) => s.end > last.start + 0.15 && s.start >= last.start + 0.1)
	if (quiet) outT = Math.min(outT + 0.4, quiet.start + 0.08)
	if (next) outT = Math.min(outT, next.start - HANDLE.minGap)
	outT = Math.max(outT, last.end, last.start + 0.12)
	const before = silences?.filter((s) => s.end <= first.start + 0.02).pop()
	if (before && (!prev || before.start >= prev.start)) inT = Math.max(inT, Math.min(before.end - 0.05, first.start - 0.02))
	inT = Math.max(0, inT)
	if (sourceDuration != null) outT = Math.min(outT, sourceDuration)
	return { in: round3(inT), out: round3(outT) }
}

const round3 = (x: number) => Math.round(x * 1000) / 1000

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

export interface AssetRef { id: string; name: string; path?: string }

const base = (p: string) => p.split(/[\\/]/).pop()!.toLowerCase().replace(/\.(lrf|proxy\.mp4)$/i, '')
const stem = (p: string) => base(p).replace(/\.[^.]+$/, '')

/** Match a picks-file source to an imported asset: same path, then same file name, then same name without extension. */
export function matchAsset(source: string, assets: AssetRef[]): AssetRef | undefined {
	return assets.find((a) => a.path && a.path === source)
		?? assets.find((a) => (a.path && base(a.path) === base(source)) || a.name.toLowerCase() === base(source))
		?? assets.find((a) => (a.path && stem(a.path) === stem(source)) || stem(a.name) === stem(source))
}

export function storyFromPicksFile(file: PicksFile, assets: AssetRef[]): { story: Story; unmatched: string[] } {
	const unmatched: string[] = []
	const picks: StoryPick[] = []
	for (const p of file.picks ?? []) {
		const a = matchAsset(String(p.source), assets)
		if (!a) { unmatched.push(String(p.source)); continue }
		picks.push({ id: newPickId(), assetId: a.id, in: Number(p.in), out: Number(p.out), speaker: p.speaker, take: p.take,
			text: String(p.text ?? ''), note: p.note,
			wordIn: typeof p.wordIn === 'number' ? (p.wordIn as number) : undefined,
			wordOut: typeof p.wordOut === 'number' ? (p.wordOut as number) : undefined })
	}
	return { story: { id: `st_${Date.now().toString(36)}`, name: file.name || 'Imported story', picks, createdAt: Date.now() }, unmatched }
}

export function picksFileFromStory(story: Story, assets: AssetRef[], fps = 25): PicksFile {
	const byId = new Map(assets.map((a) => [a.id, a]))
	return { version: 1, name: story.name, fps, picks: story.picks.map((p) => ({
		source: byId.get(p.assetId)?.path ?? byId.get(p.assetId)?.name ?? p.assetId, in: p.in, out: p.out,
		speaker: p.speaker, take: p.take, text: p.text, note: p.note, id: p.id, wordIn: p.wordIn, wordOut: p.wordOut })) }
}
