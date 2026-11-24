/**
 * Word transcripts for Story (docs/story.md): reading a clip's words from whatever transcript it has, and turning
 * imported or locally made words into FrameFlow's own transcript form (TranscriptItem[] with `words`), so captions,
 * pieces and health read them like a Gemini transcript.
 *
 * Pure and Electron-free, so tests drive it directly.
 */
import { parseWordTranscript, type Word } from '@shared/story'
import { secondsToTimestamp, timestampToSeconds, type TranscriptItem } from '../gemini/transcript-chunks'
import { groupWordsIntoSegments } from '../gemini/transcript-timing'

const clean = (t: string) => String(t ?? '').replace(/\s+/g, ' ').trim()

/**
 * Words for segments that have no word times (an older Gemini transcript, an SRT): each segment's time is shared out
 * over its words by length. Good enough to read and select; the cut edges are then only as good as the segment times,
 * which is why the result is flagged `estimated`.
 */
export function estimateWordsFromItems(items: { start: string | number; end: string | number; text: string }[]): Word[] {
	const out: Word[] = []
	for (const item of items) {
		const text = clean(item.text)
		// Audio-event markers ("[Music]", "[Silence]") are not words anyone says.
		if (!text || /^\[[^\]]*\]$/.test(text)) continue
		const start = typeof item.start === 'number' ? item.start : timestampToSeconds(item.start)
		const end = typeof item.end === 'number' ? item.end : timestampToSeconds(item.end)
		if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue
		const parts = text.split(' ').filter(Boolean)
		const total = parts.reduce((n, p) => n + p.length, 0) || 1
		let t = start
		for (const p of parts) {
			const d = ((end - start) * p.length) / total
			out.push({ text: p, start: round3(t), end: round3(t + d) })
			t += d
		}
	}
	return out.sort((a, b) => a.start - b.start)
}

/** A clip's words from the JSON of its transcript file: measured when it has them, estimated from segments when not. */
export function wordsFromTranscriptJson(json: unknown): { words: Word[]; estimated: boolean } {
	const words = parseWordTranscript(json)
	if (words.length) return { words, estimated: false }
	if (Array.isArray(json) && json.some((i) => typeof i?.text === 'string' && i.start !== undefined)) {
		return { words: estimateWordsFromItems(json as TranscriptItem[]), estimated: true }
	}
	return { words: [], estimated: false }
}

/** Words as FrameFlow transcript segments: caption-sized, each keeping its measured words. */
export function wordsToTranscriptItems(words: Word[]): TranscriptItem[] {
	return groupWordsIntoSegments(words.map((w) => ({ start: w.start, end: w.end, text: w.text }))).map((seg) => ({
		start: secondsToTimestamp(seg.start),
		end: secondsToTimestamp(seg.end),
		text: seg.text,
		words: (seg.words ?? []).map((w) => ({ start: round3(w.start), end: round3(w.end), text: w.text }))
	}))
}

/** SRT or WebVTT cues as transcript segments (sentence-level only: no word times). */
export function parseCues(text: string): TranscriptItem[] {
	const items: TranscriptItem[] = []
	const blocks = String(text).replace(/\r/g, '').split(/\n\s*\n/)
	const time = /((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/
	for (const block of blocks) {
		const lines = block.split('\n')
		const at = lines.findIndex((l) => time.test(l))
		if (at < 0) continue
		const m = time.exec(lines[at])!
		const body = clean(lines.slice(at + 1).join(' ').replace(/<[^>]+>/g, ''))
		if (!body) continue
		const start = timestampToSeconds(m[1])
		const end = timestampToSeconds(m[2])
		if (!(end >= start)) continue
		items.push({ start: secondsToTimestamp(start), end: secondsToTimestamp(end), text: body })
	}
	return items
}

export interface ParsedTranscriptFile {
	items: TranscriptItem[]
	/** Words in it (estimated for SRT/VTT). */
	words: number
	/** True when the file had no word times (SRT/VTT): cut edges will be rough. */
	estimated: boolean
	lastSec: number
}

/**
 * Any transcript file we accept, as FrameFlow transcript segments: whisper.cpp `-oj`, the catalogue `{words:[...]}`
 * form, FrameFlow's own TranscriptItem[], SRT and VTT. Throws a plain-English error for anything else.
 */
export function parseTranscriptFile(fileName: string, content: string): ParsedTranscriptFile {
	const lower = fileName.toLowerCase()
	if (lower.endsWith('.srt') || lower.endsWith('.vtt') || /^\s*WEBVTT/.test(content)) {
		const items = parseCues(content)
		if (!items.length) throw new Error('No captions found in that file.')
		const words = estimateWordsFromItems(items)
		return { items, words: words.length, estimated: true, lastSec: words.at(-1)?.end ?? 0 }
	}
	let json: unknown
	try {
		json = JSON.parse(content)
	} catch {
		throw new Error('That file is not JSON, SRT or VTT. Import a whisper.cpp JSON (-oj), a {"words": [...]} transcript, an SRT or a VTT.')
	}
	const words = parseWordTranscript(json)
	if (!words.length) {
		throw new Error('No timed words found in that file. Expected whisper.cpp JSON (-oj, ideally with -ml 1) or {"words": [{"text","start","end"}]}.')
	}
	return { items: wordsToTranscriptItems(words), words: words.length, estimated: false, lastSec: words.at(-1)!.end }
}

const round3 = (x: number) => Math.round(x * 1000) / 1000
