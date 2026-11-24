import { describe, expect, it } from 'vitest'
import { matchAsset, movePick, parseWordTranscript, pickFromWords, pickWordRange, picksFileFromStory, placeRange,
	storyFromPicksFile, wordsToLines, type Word } from './story'

const W = (t: string, s: number, e: number): Word => ({ text: t, start: s, end: e })
const words: Word[] = [W('Normally', 1.0, 1.4), W('no.', 1.45, 1.8), W('If', 3.0, 3.1), W('the', 3.12, 3.2), W('song', 3.25, 3.6),
	W('is', 3.62, 3.7), W('good.', 3.75, 4.2), W('Next', 4.5, 4.8)]

describe('parseWordTranscript', () => {
	it('reads whisper.cpp -oj with -ml 1, glues punctuation tokens, skips empties', () => {
		const j = { transcription: [{ text: ' Hello', offsets: { from: 100, to: 400 } }, { text: ',', offsets: { from: 400, to: 410 } },
			{ text: ' ', offsets: { from: 410, to: 420 } }, { text: ' world.', offsets: { from: 500, to: 900 } }] }
		expect(parseWordTranscript(j)).toEqual([W('Hello,', 0.1, 0.41), W('world.', 0.5, 0.9)])
	})
	it('splits a multi-word whisper entry by length', () => {
		const out = parseWordTranscript({ transcription: [{ text: 'ab abcd', offsets: { from: 0, to: 600 } }] })
		expect(out.map((w) => w.text)).toEqual(['ab', 'abcd'])
		expect(out[0].end).toBeCloseTo(0.2); expect(out[1].start).toBeCloseTo(0.2)
	})
	it('reads the catalogue form and skips spacing entries', () => {
		const j = { words: [{ text: 'Yeah,', start: 6.02, end: 6.6, type: 'word' }, { text: ' ', start: 6.6, end: 6.64, type: 'spacing' },
			{ text: 'I', start: 6.64, end: 6.8, type: 'word' }] }
		expect(parseWordTranscript(j)).toEqual([W('Yeah,', 6.02, 6.6), W('I', 6.64, 6.8)])
	})
	it('reads FrameFlow TranscriptItem[] with words', () => {
		expect(parseWordTranscript([{ start: '00:00:01,000', end: '00:00:02,000', text: 'a b', words: [W('a', 1, 1.2), W('b', 1.3, 1.6)] }]))
			.toEqual([W('a', 1, 1.2), W('b', 1.3, 1.6)])
	})
})

describe('lines and picks', () => {
	it('breaks lines at sentence ends and pauses', () => {
		expect(wordsToLines(words).map((l) => l.text)).toEqual(['Normally no.', 'If the song is good.', 'Next'])
	})
	it('makes a pick from a word range in any order', () => {
		const p = pickFromWords('a1', words, 6, 2, { speaker: 'Julian' })!
		expect([p.in, p.out, p.text, p.speaker]).toEqual([3.0, 4.2, 'If the song is good.', 'Julian'])
		expect(pickWordRange(p, words)).toEqual([2, 6])
	})
	it('finds a pick by time when the word indexes moved', () => {
		const p = { ...pickFromWords('a1', words, 2, 4)!, wordIn: 0, wordOut: 1 }
		expect(pickWordRange(p, words)).toEqual([2, 4])
	})
})

describe('placeRange: no word ever clips', () => {
	it('opens halfway into the pause before and closes before the next word starts', () => {
		const p = pickFromWords('a1', words, 2, 6)!
		const r = placeRange(p, words)
		expect(r.in).toBeCloseTo(2.92, 2)
		expect(r.out).toBeCloseTo(4.46, 2)
	})
	it('never reaches into the word before, even with no pause', () => {
		const tight = [W('a', 0, 1.0), W('b', 1.0, 1.5), W('c', 1.5, 2.0)]
		const r = placeRange(pickFromWords('x', tight, 1, 1)!, tight)
		expect(r.in).toBeGreaterThanOrEqual(0.98); expect(r.out).toBeLessThanOrEqual(1.5)
	})
	it('gives a short last word room even when whisper ends it at its start', () => {
		const odd = [W('take', 5.0, 5.0), W('one.', 5.2, 5.2)]
		const r = placeRange(pickFromWords('x', odd, 0, 1)!, odd)
		expect(r.out).toBeGreaterThanOrEqual(5.32)
	})
	it('closes where the audio goes quiet when whisper ends the last word early (Julian, 24 Nov)', () => {
		const j = [W('take', 142.64, 143.0), W('one.', 143.0, 143.24), W('Cool.', 144.94, 145.34)]
		const r = placeRange(pickFromWords('x', j, 0, 1)!, j, undefined, [{ start: 143.82, end: 144.9 }])
		expect(r.out).toBeCloseTo(143.9, 2)
		const noSil = placeRange(pickFromWords('x', j, 0, 1)!, j)
		expect(noSil.out).toBeGreaterThanOrEqual(143.8)
	})
	it('starts inside the quiet before the first word when the silences show it', () => {
		const r = placeRange(pickFromWords('x', words, 2, 6)!, words, undefined, [{ start: 1.9, end: 2.96 }])
		expect(r.in).toBeCloseTo(2.92, 2)
	})
	it('clamps to the file', () => {
		const r = placeRange(pickFromWords('x', words, 0, 0)!, words, 10)
		expect(r.in).toBeGreaterThanOrEqual(0.75)
	})
})

describe('stories and picks files', () => {
	const assets = [{ id: 'a1', name: 'DJI_20261123160946_0123_D.MP4', path: '/Vol/osmo/DJI_20261123160946_0123_D.MP4' },
		{ id: 'a2', name: 'Otto take', path: '/Vol/osmo/DJI_20261123171818_0126_D.MP4' }]
	it('matches by path, then file name, then stem; proxies resolve to the original', () => {
		expect(matchAsset('/Vol/osmo/DJI_20261123160946_0123_D.MP4', assets)?.id).toBe('a1')
		expect(matchAsset('/other/DJI_20261123171818_0126_D.MP4', assets)?.id).toBe('a2')
		expect(matchAsset('/other/DJI_20261123171818_0126_D.LRF', assets)?.id).toBe('a2')
		expect(matchAsset('/x/nothing.mov', assets)).toBeUndefined()
		const twins = [{ id: 'c1', name: 'C001.mov', path: '/camA/C001.mov', duration: 30 }, { id: 'c2', name: 'C001.mov', path: '/camB/C001.mov', duration: 200 }]
		expect(matchAsset('/elsewhere/C001.mov', twins)).toBeUndefined()
		expect(matchAsset('/elsewhere/C001.mov', twins, 120)?.id).toBe('c2')
	})
	it('round-trips a story through the shared picks file', () => {
		const st = { id: 's', name: 'Q1', picks: [pickFromWords('a1', words, 0, 1, { speaker: 'Julian', take: '3' })!] }
		const file = picksFileFromStory(st, assets)
		expect(file.picks[0]).toMatchObject({ source: '/Vol/osmo/DJI_20261123160946_0123_D.MP4', in: 1.0, out: 1.8, speaker: 'Julian' })
		const back = storyFromPicksFile({ ...file, picks: [...file.picks, { source: '/nope.mov', in: 0, out: 1 }] }, assets)
		expect(back.story.picks[0]).toMatchObject({ assetId: 'a1', in: 1.0, out: 1.8, text: 'Normally no.' })
		expect(back.unmatched).toEqual(['/nope.mov'])
	})
	it('reorders picks', () => {
		const st = { id: 's', name: 'Q1', picks: [0, 2, 7].map((i) => pickFromWords('a1', words, i, i)!) }
		expect(movePick(st, 2, 0).picks.map((p) => p.text)).toEqual(['Next', 'Normally', 'If'])
	})
})
