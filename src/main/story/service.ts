/**
 * Story's main-process side (docs/story.md): a clip's words and measured quiet, importing a word transcript, making
 * one with whisper.cpp, and picks files. Shared by the IPC the Story view calls and the MCP bridge agents use.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { PicksFile } from '@shared/story'
import type { MediaAsset, Thread } from '@shared/types'
import { threadManager } from '../threads'
import { getAssetDir, patchAsset, patchAssetPreprocessing } from '../editor/assets'
import { transcribeFromSource, type TranscriptSource } from '../editor/preprocess'
import { timingSidecarPath } from '../pipeline/phases/extraction'
import { detectSilence, getFFmpegBinaryPath } from '../ffmpeg'
import { cachedEnvelope } from './envelope'
import type { Envelope } from './place'
import { THREAD_DIRS } from '../constants/paths'
import { parseTranscriptFile, wordsFromTranscriptJson, wordsToTranscriptItems } from './transcript'
import { dtwPreset, findWhisperModel, runWhisper, whisperProblem, wordsFromWhisper } from './whisper'
import type { StoryWords, TranscriptWriteResult } from '../mcp/bridge'
import { timestampToSeconds, type TranscriptItem } from '../gemini/transcript-chunks'

/** Quiet short enough to sit between two words: placeRange looks for it within a quarter second of a word. */
export const STORY_SILENCE = { noiseDb: -32, minDurationSec: 0.15 }

function findAsset(threadId: string, assetId: string): { thread: Thread; asset: MediaAsset } {
	const thread = threadManager.getThread(threadId)
	const asset = thread?.editor?.media.find((a) => a.id === assetId)
	if (!thread || !asset) throw new Error('That clip is not in this project.')
	return { thread, asset }
}

const exists = (p?: string): p is string => !!p && fs.existsSync(p)

// ---------------------------------------------------------------- words and quiet

/** A clip's words (SOURCE seconds) and the quiet between them. */
export async function getStoryWords(threadId: string, assetId: string, options: { silences?: boolean; envelope?: boolean } = {}): Promise<StoryWords> {
	const { thread, asset } = findAsset(threadId, assetId)
	const transcriptPath = asset.preprocessing?.transcriptPath
	if (!exists(transcriptPath)) return { words: [], silences: null }
	let parsed: ReturnType<typeof wordsFromTranscriptJson>
	try {
		parsed = wordsFromTranscriptJson(JSON.parse(fs.readFileSync(transcriptPath, 'utf-8')))
	} catch (error: any) {
		throw new Error(`The clip's transcript could not be read (${error?.message || error}).`)
	}
	const silences = parsed.words.length && options.silences !== false ? await silencesFor(thread, asset).catch(() => null) : null
	const envelope = parsed.words.length && options.envelope ? await envelopeFor(thread, asset).catch(() => null) : undefined
	return { words: parsed.words, silences, ...(parsed.estimated ? { estimated: true } : {}), ...(envelope !== undefined ? { envelope } : {}) }
}

/** The sound a clip is measured from: the extracted 16 kHz audio (small, the transcript's clock), else the original. */
const soundSource = (asset: MediaAsset) => [asset.preprocessing?.audioPath, asset.originalPath, asset.proxyPath].find(exists)

/** The clip's loudness every 10 ms (envelope.ts), decoded once and kept in its story/ folder. Null without sound. */
export function envelopeFor(thread: Thread, asset: MediaAsset): Promise<Envelope | null> {
	if (asset.metadata && asset.metadata.hasAudio === false) return Promise.resolve(null)
	const source = soundSource(asset)
	if (!source) return Promise.resolve(null)
	return slot(() => cachedEnvelope(source, path.join(getAssetDir(thread, asset.id), 'story'), getFFmpegBinaryPath()))
}

/** Two measurements at a time: the Story view asks for every clip at once. */
let running = 0
const waiting: Array<() => void> = []
async function slot<T>(work: () => Promise<T>): Promise<T> {
	if (running >= 2) await new Promise<void>((resolve) => waiting.push(resolve))
	running++
	try {
		return await work()
	} finally {
		running--
		waiting.shift()?.()
	}
}
const inFlight = new Map<string, Promise<{ start: number; end: number }[] | null>>()

/**
 * Quiet stretches of a clip in SOURCE seconds, measured once and kept beside the clip (story/silences.json), keyed by
 * the file measured and the thresholds. Read from the extracted audio when there is one (small, on the transcript's
 * clock), else from the original.
 */
export function silencesFor(thread: Thread, asset: MediaAsset): Promise<{ start: number; end: number }[] | null> {
	if (asset.metadata && asset.metadata.hasAudio === false) return Promise.resolve(null)
	const source = soundSource(asset)
	if (!source) return Promise.resolve(null)
	const cacheFile = path.join(getAssetDir(thread, asset.id), 'story', 'silences.json')
	const stat = fs.statSync(source)
	const key = { v: 1, source, size: stat.size, mtimeMs: Math.round(stat.mtimeMs), ...STORY_SILENCE }
	try {
		const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'))
		if (JSON.stringify(cached.key) === JSON.stringify(key) && Array.isArray(cached.silences)) return Promise.resolve(cached.silences)
	} catch { /* not measured yet */ }
	const flightKey = `${cacheFile}|${source}`
	const running = inFlight.get(flightKey)
	if (running) return running
	const work = slot(async () => {
		const regions = await detectSilence(source, STORY_SILENCE)
		const silences = regions.map((r) => ({ start: round3(r.start), end: round3(r.end) }))
		try {
			fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
			fs.writeFileSync(cacheFile, JSON.stringify({ key, silences }))
		} catch { /* a cache is a nicety */ }
		return silences
	}).finally(() => inFlight.delete(flightKey))
	inFlight.set(flightKey, work)
	return work
}

// ---------------------------------------------------------------- writing a transcript

/**
 * Make `items` the clip's transcript: transcripts/raw_transcript.json, as a Gemini run writes it. A transcript that
 * was there is kept beside it (raw_transcript.before-<time>.json): a Gemini transcript cost money. The old run's timing
 * verdict goes, since it describes a transcript that is no longer used.
 */
export async function writeAssetTranscript(
	threadId: string,
	assetId: string,
	assetDir: string,
	items: TranscriptItem[],
	origin: { from: string; model?: string; file?: string; dtw?: string }
): Promise<string> {
	const dir = path.join(assetDir, THREAD_DIRS.TRANSCRIPTS)
	fs.mkdirSync(dir, { recursive: true })
	const file = path.join(dir, 'raw_transcript.json')
	if (fs.existsSync(file)) {
		const stamp = new Date().toISOString().replace(/[:.]/g, '-')
		fs.renameSync(file, path.join(dir, `raw_transcript.before-${stamp}.json`))
	}
	fs.rmSync(timingSidecarPath(file), { force: true })
	fs.writeFileSync(file, JSON.stringify(items, null, 2))
	fs.writeFileSync(path.join(dir, 'raw_transcript.origin.json'), JSON.stringify({ ...origin, at: new Date().toISOString() }, null, 2))
	// The corrected transcript (if any) was made from the old words: it no longer applies.
	await patchAssetPreprocessing(threadId, assetId, { rawTranscriptPath: file, transcriptPath: file, correctedTranscriptPath: undefined })
	return file
}

/** Import a word-level transcript file as the clip's transcript. The file is checked before anything is replaced. */
export async function importAssetTranscript(threadId: string, assetId: string, filePath: string): Promise<TranscriptWriteResult> {
	try {
		const { asset } = findAsset(threadId, assetId)
		if (!filePath || !fs.existsSync(filePath)) return { ok: false, words: 0, error: `No file at ${filePath}.` }
		if (fs.statSync(filePath).size > 64 * 1024 * 1024) return { ok: false, words: 0, error: 'That file is too big to be a transcript.' }
		const parsed = parseTranscriptFile(path.basename(filePath), fs.readFileSync(filePath, 'utf-8'))
		const notes: string[] = []
		const duration = asset.metadata?.duration
		if (duration && parsed.lastSec > duration + 2) {
			const first = parseTranscriptFirst(parsed.items)
			if (first > duration) {
				return { ok: false, words: 0, error: `That transcript starts at ${first.toFixed(1)}s but ${asset.name} is only ${duration.toFixed(1)}s long. Is it the transcript of another clip?` }
			}
			notes.push(`The transcript runs to ${parsed.lastSec.toFixed(1)}s, past the clip's end (${duration.toFixed(1)}s): check it is this clip's.`)
		}
		if (parsed.estimated) notes.push('The file has no word timings (SRT/VTT): words are shared out over each caption, so pick edges are rough.')
		const source: TranscriptSource = {
			label: 'Importing the transcript…',
			model: 'the imported transcript',
			needsAudio: false,
			async run(ctx) {
				await writeAssetTranscript(threadId, assetId, ctx.assetDir, parsed.items, { from: 'import', file: filePath })
			}
		}
		const result = await transcribeFromSource(threadId, assetId, source)
		if (!result.ok) return { ok: false, words: 0, error: result.error }
		return { ok: true, words: parsed.words, ...(parsed.estimated ? { estimated: true } : {}), ...(notes.length ? { notes } : {}) }
	} catch (error: any) {
		return { ok: false, words: 0, error: error?.message || String(error) }
	}
}

function parseTranscriptFirst(items: TranscriptItem[]): number {
	const first = items[0]
	if (!first) return 0
	return first.words?.length ? first.words[0].start : timestampToSeconds(first.start)
}

const localRuns = new Map<string, AbortController>()

/** Transcribe a clip with whisper.cpp on this Mac, as its transcript. Resolves when done; `abortLocalTranscribe` stops it. */
export async function transcribeAssetLocally(
	threadId: string,
	assetId: string,
	options: { userDataDir?: string; onProgress?: (percent: number, label: string) => void } = {}
): Promise<TranscriptWriteResult> {
	const key = `${threadId}:${assetId}`
	try {
		findAsset(threadId, assetId)
		const problem = whisperProblem(options.userDataDir)
		if (problem) return { ok: false, words: 0, error: problem }
		if (localRuns.has(key)) return { ok: false, words: 0, error: 'This clip is already being transcribed on this Mac.' }
		const controller = new AbortController()
		localRuns.set(key, controller)
		const model = findWhisperModel(options.userDataDir)!
		let count = 0
		const source: TranscriptSource = {
			label: 'Transcribing on this Mac (whisper.cpp)…',
			model: 'whisper.cpp',
			needsAudio: true,
			async run(ctx) {
				if (!ctx.audioPath) throw new Error('The clip\'s sound could not be extracted, so there is nothing to transcribe.')
				const signal = AbortSignal.any([ctx.signal, controller.signal])
				let last = -1
				const json = await runWhisper({
					audioPath: ctx.audioPath, model, signal,
					onProgress: (percent) => {
						if (percent === last) return
						last = percent
						const label = `Transcribing on this Mac (whisper.cpp)… ${percent}%`
						void ctx.progress(Math.max(5, Math.min(84, Math.round(5 + percent * 0.8))), label)
						options.onProgress?.(percent, label)
					}
				})
				const words = wordsFromWhisper(json)
				if (!words.length) throw new Error('whisper.cpp heard no words in this clip.')
				count = words.length
				await writeAssetTranscript(threadId, assetId, ctx.assetDir, wordsToTranscriptItems(words), { from: 'whisper.cpp', model: path.basename(model), dtw: dtwPreset(model) ?? undefined })
			}
		}
		const result = await transcribeFromSource(threadId, assetId, source)
		if (!result.ok && controller.signal.aborted) {
			// A person stopped it: not a failure to show on the clip, which keeps the transcript it had.
			await patchAsset(threadId, assetId, { transcriptError: undefined })
			return { ok: false, words: 0, error: 'Stopped.' }
		}
		if (!result.ok) return { ok: false, words: 0, error: result.error }
		return { ok: true, words: count }
	} catch (error: any) {
		return { ok: false, words: 0, error: error?.message || String(error) }
	} finally {
		localRuns.delete(key)
	}
}

/** Stop a local transcription. True when one was running. */
export function abortLocalTranscribe(threadId: string, assetId: string): boolean {
	const run = localRuns.get(`${threadId}:${assetId}`)
	run?.abort()
	return !!run
}

// ---------------------------------------------------------------- picks files

/** Where picks files go by default: ~/Studio/runs (each run keeps them in its own picks/ folder). */
export function storyDefaults(): { folder: string } {
	return { folder: path.join(os.homedir(), 'Studio', 'runs') }
}

const expandHome = (p: string) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p)

export function readPicksFile(filePath: string): PicksFile {
	const file = expandHome(String(filePath || ''))
	if (!file || !fs.existsSync(file)) throw new Error(`No picks file at ${filePath}.`)
	let json: any
	try {
		json = JSON.parse(fs.readFileSync(file, 'utf-8'))
	} catch {
		throw new Error('That file is not JSON.')
	}
	if (!json || typeof json !== 'object' || !Array.isArray(json.picks)) throw new Error('That is not a picks file: it has no "picks" list.')
	return { ...json, name: typeof json.name === 'string' && json.name ? json.name : path.basename(file, '.json') }
}

/** Write a picks file (an object, or JSON text), making its folder. Returns the path written. */
export function writePicksFile(filePath: string, data: unknown): string {
	const file = expandHome(String(filePath || ''))
	if (!file || !path.isAbsolute(file)) throw new Error('Give an absolute path for the picks file.')
	const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
	JSON.parse(text) // refuse to write something that will not read back
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`)
	return file
}

const round3 = (x: number) => Math.round(x * 1000) / 1000
