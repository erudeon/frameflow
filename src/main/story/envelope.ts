/**
 * A clip's loudness over time, for cutting a pick at the sound rather than at word times (place.ts refineRange): the
 * RMS level in dB of every 10 ms of the 16 kHz mono sound, each over a 30 ms window centred on its time. Decoded once
 * per clip and kept beside it (story/envelope.f32 with its key in story/envelope.json).
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Envelope } from './place'

export const ENVELOPE = { rate: 16000, hopSec: 0.01, windowSec: 0.03, floorDb: -100 }

/** The envelope of 16-bit mono samples: frame i is centred on i × hop. */
export function envelopeFromSamples(samples: Int16Array, rate = ENVELOPE.rate): Envelope {
	const hop = Math.round(rate * ENVELOPE.hopSec)
	const half = Math.round((rate * ENVELOPE.windowSec) / 2)
	const frames = Math.max(0, Math.ceil(samples.length / hop))
	const db = new Float32Array(frames)
	for (let i = 0; i < frames; i++) {
		const c = i * hop
		const a = Math.max(0, c - half), b = Math.min(samples.length, c + half)
		let sum = 0
		for (let k = a; k < b; k++) sum += samples[k] * samples[k]
		const rms = b > a ? Math.sqrt(sum / (b - a)) / 32768 : 0
		db[i] = rms > 0 ? Math.max(ENVELOPE.floorDb, 20 * Math.log10(rms)) : ENVELOPE.floorDb
	}
	return { hopSec: ENVELOPE.hopSec, db }
}

/** Decode a file's first audio track to 16 kHz mono and measure it. */
export function decodeEnvelope(audioPath: string, ffmpegPath: string, signal?: AbortSignal): Promise<Envelope> {
	return new Promise((resolve, reject) => {
		const child = spawn(ffmpegPath, ['-v', 'error', '-nostdin', '-i', audioPath, '-map', '0:a:0', '-ac', '1', '-ar', String(ENVELOPE.rate), '-f', 's16le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] })
		const chunks: Buffer[] = []
		let err = ''
		const onAbort = () => child.kill('SIGKILL')
		signal?.addEventListener('abort', onAbort, { once: true })
		child.stdout.on('data', (c: Buffer) => chunks.push(c))
		child.stderr.on('data', (c: Buffer) => { err = (err + c.toString()).slice(-2000) })
		child.on('error', reject)
		child.on('close', (code) => {
			signal?.removeEventListener('abort', onAbort)
			if (signal?.aborted) return reject(new Error('Stopped.'))
			if (code !== 0) return reject(new Error(`ffmpeg could not decode the sound (${code}): ${err.trim().split('\n').pop() || ''}`))
			const buf = Buffer.concat(chunks)
			const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2))
			resolve(envelopeFromSamples(samples.slice()))
		})
	})
}

/** The envelope of `source`, from the cache in `dir` when it was made from the same file, else decoded and cached. */
export async function cachedEnvelope(source: string, dir: string, ffmpegPath: string): Promise<Envelope> {
	const stat = fs.statSync(source)
	const key = { v: 1, source, size: stat.size, mtimeMs: Math.round(stat.mtimeMs), ...ENVELOPE }
	const keyFile = path.join(dir, 'envelope.json')
	const dataFile = path.join(dir, 'envelope.f32')
	try {
		if (JSON.stringify(JSON.parse(fs.readFileSync(keyFile, 'utf-8'))) === JSON.stringify(key)) {
			const buf = fs.readFileSync(dataFile)
			return { hopSec: ENVELOPE.hopSec, db: new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)) }
		}
	} catch { /* not measured yet */ }
	const env = await decodeEnvelope(source, ffmpegPath)
	try {
		fs.mkdirSync(dir, { recursive: true })
		const db = env.db as Float32Array
		fs.writeFileSync(dataFile, Buffer.from(db.buffer, db.byteOffset, db.byteLength))
		fs.writeFileSync(keyFile, JSON.stringify(key))
	} catch { /* a cache is a nicety */ }
	return env
}
