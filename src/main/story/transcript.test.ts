import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseWordTranscript } from '@shared/story'
import { estimateWordsFromItems, parseCues, parseTranscriptFile, wordsFromTranscriptJson, wordsToTranscriptItems } from './transcript'
import { timestampToSeconds } from '../gemini/transcript-chunks'

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'whisper-oj.json'), 'utf-8')

describe('importing a word transcript', () => {
	it('reads whisper.cpp -oj (-ml 1) into FrameFlow transcript segments that keep every word', () => {
		const parsed = parseTranscriptFile('clip.json', fixture)
		expect(parsed.estimated).toBe(false)
		// The empty first entry whisper writes is dropped; 13 spoken words remain.
		expect(parsed.words).toBe(13)
		const words = parsed.items.flatMap((i) => i.words ?? [])
		expect(words.map((w) => w.text).join(' ')).toBe("uh dj requests uh disqualify i'm just recording this for the ai editor")
		expect(words[2]).toEqual({ start: 2.22, end: 3.02, text: 'requests' })
		// Segment times agree with their first and last word.
		for (const item of parsed.items) {
			expect(timestampToSeconds(item.start)).toBeCloseTo(item.words![0].start, 3)
			expect(timestampToSeconds(item.end)).toBeCloseTo(item.words!.at(-1)!.end, 3)
		}
		// And it reads back as the same words, which is what the Story view and captions get.
		expect(parseWordTranscript(parsed.items)).toEqual(parseWordTranscript(JSON.parse(fixture)))
	})

	it('reads the catalogue form {words:[...]} and skips spacing entries', () => {
		const file = JSON.stringify({ language_code: 'en', words: [
			{ text: 'Should', start: 10.1, end: 10.4, type: 'word' }, { text: ' ', start: 10.4, end: 10.45, type: 'spacing' },
			{ text: 'DJs', start: 10.45, end: 10.9, type: 'word' }, { text: 'take', start: 11.0, end: 11.3, type: 'word' },
			{ text: 'requests?', start: 11.35, end: 12.0, type: 'word' }
		] })
		const parsed = parseTranscriptFile('DJI_0123.json', file)
		expect(parsed.words).toBe(4)
		expect(parsed.items).toHaveLength(1) // a question mark ends the segment
		expect(parsed.items[0].text).toBe('Should DJs take requests?')
		expect(parsed.lastSec).toBe(12)
	})

	it('takes SRT and VTT as sentence times, flagged as estimated', () => {
		const srt = '1\n00:00:01,000 --> 00:00:03,000\nHello there\n\n2\n00:00:04,500 --> 00:00:06,000\nGeneral <i>Kenobi</i>\n'
		const parsed = parseTranscriptFile('x.srt', srt)
		expect(parsed.estimated).toBe(true)
		expect(parsed.items.map((i) => i.text)).toEqual(['Hello there', 'General Kenobi'])
		expect(parsed.words).toBe(4)
		const vtt = 'WEBVTT\n\n00:01.000 --> 00:02.500\nOne two\n'
		expect(parseCues(vtt)).toEqual([{ start: '00:00:01,000', end: '00:00:02,500', text: 'One two' }])
	})

	it('refuses what it cannot read, in plain words', () => {
		expect(() => parseTranscriptFile('x.json', 'not json')).toThrow(/not JSON, SRT or VTT/)
		expect(() => parseTranscriptFile('x.json', JSON.stringify({ hello: 1 }))).toThrow(/No timed words/)
		expect(() => parseTranscriptFile('x.srt', 'nothing here')).toThrow(/No captions/)
	})
})

describe('a clip\'s words from its transcript', () => {
	it('uses measured words when the transcript has them', () => {
		const items = wordsToTranscriptItems([{ text: 'Hi.', start: 1, end: 1.3 }, { text: 'Bye', start: 2, end: 2.4 }])
		expect(wordsFromTranscriptJson(items)).toEqual({ words: [{ text: 'Hi.', start: 1, end: 1.3 }, { text: 'Bye', start: 2, end: 2.4 }], estimated: false })
	})

	it('shares segment time out over the words of an older transcript, and says so', () => {
		const { words, estimated } = wordsFromTranscriptJson([
			{ start: '00:00:01,000', end: '00:00:02,000', text: 'aa bbbb cc' },
			{ start: '00:00:02,000', end: '00:00:03,000', text: '[Music]' }
		])
		expect(estimated).toBe(true)
		expect(words.map((w) => w.text)).toEqual(['aa', 'bbbb', 'cc'])
		expect(words[0]).toEqual({ text: 'aa', start: 1, end: 1.25 })
		expect(words[2].end).toBe(2)
		expect(estimateWordsFromItems([{ start: 5, end: 4, text: 'backwards' }])).toEqual([])
	})
})

describe('whisper.cpp words with DTW token times', () => {
	it('starts each word at its first token\'s DTW time, a little earlier, and keeps the decoder\'s time without one', async () => {
		const { wordsFromWhisper, whisperArgs, DTW_LEAD_SEC } = await import('./whisper')
		const json = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'whisper-ojf-dtw.json'), 'utf-8'))
		const words = wordsFromWhisper(json)
		expect(words.map((w) => w.text).join(' ')).toBe("It's an interesting question, so why do I like playing B2B with Emilio?")
		// " why": decoder 1.28 s, DTW 1.68 s.
		expect(words[5]).toMatchObject({ text: 'why', start: Math.round((1.68 - DTW_LEAD_SEC) * 1000) / 1000 })
		for (let i = 1; i < words.length; i++) expect(words[i].start).toBeGreaterThan(words[i - 1].start)
		// No DTW at all (plain -oj): the decoder's times, as parseWordTranscript reads them.
		expect(wordsFromWhisper(JSON.parse(fixture))).toEqual(parseWordTranscript(JSON.parse(fixture)))
		// DTW only for a model it has a preset for, and then with flash attention off and the full JSON.
		expect(whisperArgs('/m/ggml-large-v3-turbo.bin', 'a.mp3', '/tmp/o', 4)).toEqual(expect.arrayContaining(['-dtw', 'large.v3.turbo', '-nfa', '-ojf']))
		expect(whisperArgs('/m/ggml-small.bin', 'a.mp3', '/tmp/o', 4)).not.toContain('-dtw')
	})
})
