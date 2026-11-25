/**
 * whisper.cpp on this Mac (docs/story.md, "Local engine"): word timestamps, free, offline. FrameFlow does not ship the
 * binary or the model; it finds `whisper-cli` (Homebrew's whisper-cpp) and a ggml model where they usually live.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseWordTranscript, type Word } from '@shared/story'

export const WHISPER_MODEL_FILE = 'ggml-large-v3-turbo.bin'

/** Where whisper-cli may be: PATH first, then Homebrew's two prefixes. */
export function findWhisperBinary(env: NodeJS.ProcessEnv = process.env): string | null {
	const dirs = [...String(env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean)
	for (const dir of dirs) {
		for (const name of ['whisper-cli', 'whisper-cpp']) {
			const file = path.join(dir, name)
			try {
				fs.accessSync(file, fs.constants.X_OK)
				return file
			} catch { /* not here */ }
		}
	}
	return null
}

/**
 * The model, in this order: FRAMEFLOW_WHISPER_MODEL, the app's own models folder, ~/.cache/whisper, then the copy
 * this Mac already has from an earlier run.
 */
export function whisperModelCandidates(userDataDir?: string, env: NodeJS.ProcessEnv = process.env): string[] {
	const home = os.homedir()
	return [
		env.FRAMEFLOW_WHISPER_MODEL,
		userDataDir && path.join(userDataDir, 'models', WHISPER_MODEL_FILE),
		path.join(home, 'Library', 'Application Support', 'frameflow', 'models', WHISPER_MODEL_FILE),
		path.join(home, '.cache', 'whisper', WHISPER_MODEL_FILE),
		path.join(home, 'Developer', 'runs', '2026-11-11-elgato-prompter-yoink', 'models', WHISPER_MODEL_FILE)
	].filter((p): p is string => !!p)
}

export function findWhisperModel(userDataDir?: string, env: NodeJS.ProcessEnv = process.env): string | null {
	return whisperModelCandidates(userDataDir, env).find((p) => {
		try { return fs.statSync(p).size > 1_000_000 } catch { return false }
	}) ?? null
}

/** Why local transcription cannot run here, in words a person can act on; null when it can. */
export function whisperProblem(userDataDir?: string): string | null {
	if (!findWhisperBinary()) return 'whisper.cpp is not installed on this Mac. Install it with: brew install whisper-cpp'
	if (!findWhisperModel(userDataDir)) {
		const where = whisperModelCandidates(userDataDir).slice(1, 3).join(' or ')
		return `No whisper model found. Put ${WHISPER_MODEL_FILE} in ${where} (download: https://huggingface.co/ggerganov/whisper.cpp).`
	}
	return null
}

/**
 * The DTW alignment preset for a model file, when whisper.cpp has one: token times from the attention alignment
 * rather than from the decoder's timestamp tokens. A preset that does not match the model aligns nonsense, so only a
 * recognised file name gets one.
 */
export function dtwPreset(model: string): string | null {
	const name = path.basename(model).toLowerCase()
	if (/large-v3-turbo/.test(name)) return 'large.v3.turbo'
	if (/large-v3/.test(name)) return 'large.v3'
	return null
}

/**
 * The whisper-cli arguments: one word per entry (-ml 1, split on words), language detected, full JSON (-ojf, which has
 * each token's DTW time). DTW needs flash attention off (-nfa); without it every t_dtw is -1.
 */
export function whisperArgs(model: string, audioPath: string, outBase: string, threads = Math.min(8, Math.max(2, os.cpus().length - 2))): string[] {
	const dtw = dtwPreset(model)
	return [
		'-m', model, '-f', audioPath, '-ml', '1', '-sow', '-l', 'auto', '-np', '-nf', '-pp', '-t', String(threads),
		...(dtw ? ['-dtw', dtw, '-nfa', '-ojf'] : ['-oj']), '-of', outBase
	]
}

/**
 * How much earlier than its DTW time a word really starts. Measured on the 23 Nov interviews (24 cuts re-transcribed):
 * cut at the DTW time the first word survived 4 times in 24, cut 0.15 s before it 8 times; the decoder's own word
 * times did no better than DTW. whisper's long-form word times stay rough either way.
 */
export const DTW_LEAD_SEC = 0.15

/**
 * Words from whisper-cli JSON. With -ojf and DTW, a word starts at its first token's DTW time (less DTW_LEAD_SEC);
 * a word without one keeps the decoder's time. Plain -oj goes through parseWordTranscript.
 */
export function wordsFromWhisper(json: any): Word[] {
	const segments: any[] = Array.isArray(json?.transcription) ? json.transcription : []
	const hasDtw = segments.some((s) => Array.isArray(s?.tokens) && s.tokens.some((t: any) => typeof t?.t_dtw === 'number' && t.t_dtw >= 0))
	if (!hasDtw) return parseWordTranscript(json)
	const words: Word[] = []
	for (const seg of segments) {
		const text = String(seg?.text ?? '').replace(/\s+/g, ' ').trim()
		const from = seg?.offsets?.from, to = seg?.offsets?.to
		if (!text || typeof from !== 'number' || typeof to !== 'number') continue
		const first = (seg.tokens ?? []).find((t: any) => !String(t?.text ?? '').startsWith('[_') && String(t?.text ?? '').trim())
		const dtw = typeof first?.t_dtw === 'number' && first.t_dtw >= 0 ? first.t_dtw / 100 - DTW_LEAD_SEC : null
		const prev = words[words.length - 1]
		const start = Math.max(0, prev ? prev.start + 0.02 : 0, dtw ?? from / 1000)
		// A punctuation-only entry belongs to the word before it.
		if (/^[.,!?;:…"')\]]+$/.test(text) && prev) {
			prev.text += text
			prev.end = Math.max(prev.end, to / 1000)
			continue
		}
		words.push({ text, start: round3(start), end: round3(Math.max(start + 0.05, to / 1000)) })
	}
	return words
}

const round3 = (x: number) => Math.round(x * 1000) / 1000

/**
 * Run whisper-cli on a 16 kHz mono file and return its `-oj` JSON. Progress is read from its progress lines; an abort
 * kills the process. The work folder is removed either way.
 */
export async function runWhisper(options: {
	audioPath: string
	binary?: string
	model?: string
	userDataDir?: string
	signal?: AbortSignal
	onProgress?: (percent: number) => void
}): Promise<unknown> {
	const binary = options.binary ?? findWhisperBinary()
	const model = options.model ?? findWhisperModel(options.userDataDir)
	const problem = !binary || !model ? whisperProblem(options.userDataDir) : null
	if (problem) throw new Error(problem)
	if (options.signal?.aborted) throw new Error('Stopped.')
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-whisper-'))
	const outBase = path.join(work, 'words')
	try {
		await new Promise<void>((resolve, reject) => {
			const child = spawn(binary!, whisperArgs(model!, options.audioPath, outBase), { stdio: ['ignore', 'ignore', 'pipe'] })
			let tail = ''
			const onAbort = () => child.kill('SIGKILL')
			options.signal?.addEventListener('abort', onAbort, { once: true })
			child.stderr.on('data', (chunk: Buffer) => {
				const text = chunk.toString()
				tail = (tail + text).slice(-4000)
				for (const m of text.matchAll(/progress\s*=\s*(\d+)%/g)) options.onProgress?.(Number(m[1]))
			})
			child.on('error', (err) => {
				options.signal?.removeEventListener('abort', onAbort)
				reject(err)
			})
			child.on('close', (code) => {
				options.signal?.removeEventListener('abort', onAbort)
				if (options.signal?.aborted) return reject(new Error('Stopped.'))
				if (code === 0) return resolve()
				const last = tail.trim().split('\n').filter((l) => !/progress\s*=/.test(l)).slice(-3).join(' ')
				reject(new Error(`whisper.cpp stopped with code ${code}${last ? `: ${last}` : ''}`))
			})
		})
		const file = `${outBase}.json`
		if (!fs.existsSync(file)) throw new Error('whisper.cpp finished but wrote no transcript.')
		return JSON.parse(fs.readFileSync(file, 'utf-8'))
	} finally {
		fs.rmSync(work, { recursive: true, force: true })
	}
}
