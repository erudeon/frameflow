import { describe, expect, it } from 'vitest'
import type { EditorDocument, MediaAsset, MulticamGroup, TimelineItem } from '@shared/types'
import { pickFromWords, placeRange, type Story, type Word } from '@shared/story'
import { applyTimelineDiff } from '@shared/timeline'
import { buildStoryPlacement, itemsToReplace, mainVideoTrack, type WordSource } from './place'

const asset = (id: string, duration = 60, kind: 'video' | 'audio' = 'video'): MediaAsset => ({
	id, kind, name: `${id}.mp4`, originalPath: `/media/${id}.mp4`, metadata: { duration } as MediaAsset['metadata'],
	preprocessing: {}, clips: [], createdAt: 0
})

const words = (pairs: Array<[number, number, string]>): Word[] => pairs.map(([start, end, text]) => ({ start, end, text }))

// Two takes of the same answer.
const A = words([[10, 10.3, 'So'], [10.35, 10.7, 'the'], [10.75, 11.2, 'answer'], [11.25, 11.5, 'is'], [11.55, 12.1, 'yes.'], [14, 14.4, 'Next'], [14.45, 14.9, 'one.']])
const B = words([[3, 3.4, 'Honestly,'], [3.5, 3.8, 'it'], [3.85, 4.3, 'depends.'], [6, 6.3, 'Okay.']])
const SOURCES: Record<string, WordSource> = {
	a: { words: A, silences: [{ start: 8, end: 9.95 }, { start: 12.15, end: 13.9 }] },
	b: { words: B, silences: null }
}

function makeDoc(): EditorDocument {
	const item = (id: string, trackId: string, timelineStart: number, sourceAssetId = 'a'): TimelineItem => ({
		id, trackId, sourceAssetId, timelineStart, in: 0, out: 15, speed: 1, preservePitch: true, duration: 15
	})
	return {
		schemaVersion: 2,
		media: [asset('a'), asset('b'), asset('music', 120, 'audio')],
		tracks: [
			{ id: 'v1', kind: 'video', name: 'V1', order: 0, muted: false, locked: false, hidden: false, height: 64 },
			{ id: 'v2', kind: 'video', name: 'V2', order: 1, muted: false, locked: false, hidden: false, height: 64 },
			{ id: 'a1', kind: 'audio', name: 'A1', order: 0, muted: false, locked: false, hidden: false, height: 64 }
		],
		timeline: [item('old1', 'v1', 0), item('old2', 'v1', 15), item('broll', 'v2', 3, 'b'), { ...item('bed', 'a1', 0, 'music'), out: 120, duration: 120 }],
		timelineMeta: { fps: 25, width: 1920, height: 1080, duration: 30, frameChosen: true },
		turns: [],
		historyRef: { currentStepId: 's0', stepCount: 0 }
	}
}

const story = (picks: Story['picks']): Story => ({ id: 'st1', name: 'Q1', picks })

describe('putting a story on the timeline', () => {
	it('replaces the main track with the picks, back to back from 0, each with handles so no word clips', () => {
		const doc = makeDoc()
		const p1 = pickFromWords('a', A, 1, 4, { speaker: 'Bas' })!
		const p2 = pickFromWords('b', B, 0, 2)!
		const out = buildStoryPlacement(doc, story([p1, p2]), 'replace', SOURCES, { by: 'Story', speakerOf: (p) => p.speaker })
		expect(out.removed).toBe(2)
		expect(out.diff.removeItemIds).toEqual(['old1', 'old2'])
		expect(out.placed).toBe(2)
		expect(out.droppedOps).toEqual([])
		const adds = out.diff.addItems!
		expect(adds.map((i) => i.trackId)).toEqual(['v1', 'v1'])
		const r1 = placeRange(p1, A, 60, SOURCES.a.silences!)
		const r2 = placeRange(p2, B, 60)
		expect(adds[0]).toMatchObject({ sourceAssetId: 'a', in: r1.in, out: r1.out, timelineStart: 0 })
		expect(adds[1]).toMatchObject({ sourceAssetId: 'b', in: r2.in, out: r2.out })
		expect(adds[1].timelineStart).toBeCloseTo(r1.out - r1.in, 3)
		// Handles: the cut opens before the first word and closes after the last.
		expect(adds[0].in).toBeLessThan(A[1].start)
		expect(adds[0].in).toBeGreaterThan(A[0].start) // never takes in the word before
		expect(adds[0].out).toBeGreaterThanOrEqual(A[4].end)
		expect(adds[1].in).toBeLessThan(B[0].start)
		expect(adds[1].out).toBeGreaterThanOrEqual(B[2].end)
		expect(adds[0].label).toMatch(/^Bas · "the answer is yes\."$/)
		expect(out.toSec).toBeCloseTo((r1.out - r1.in) + (r2.out - r2.in), 3)
		// B-roll on V2 and the music bed stay.
		const applied = { tracks: doc.tracks, timeline: doc.timeline, motionKits: [], multicams: [] }
		const result = applyTimelineDiff(applied, out.diff, doc.media)
		expect(result.errors).toEqual([])
		expect(applied.timeline.map((i) => i.id)).toEqual(expect.arrayContaining(['broll', 'bed']))
	})

	it('appends after what is on the main track and removes nothing', () => {
		const doc = makeDoc()
		const out = buildStoryPlacement(doc, story([pickFromWords('b', B, 3, 3)!]), 'append', SOURCES)
		expect(out.removed).toBe(0)
		expect(out.diff.removeItemIds).toBeUndefined()
		expect(out.diff.addItems![0].timelineStart).toBe(30)
		expect(out.fromSec).toBe(30)
	})

	it('places a pick at its stored edges when its clip has no words, and says so', () => {
		const doc = makeDoc()
		const out = buildStoryPlacement(doc, story([{ id: 'p', assetId: 'b', in: 3, out: 4.3, text: 'x' }]), 'replace', {})
		expect(out.diff.addItems![0]).toMatchObject({ in: 3, out: 4.3 })
		expect(out.notes.join(' ')).toMatch(/no word timings/)
	})

	it('drops a pick whose clip is gone and keeps the rest', () => {
		const doc = makeDoc()
		const out = buildStoryPlacement(doc, story([{ id: 'p', assetId: 'gone', in: 1, out: 2, text: 'lost words' }, pickFromWords('b', B, 0, 2)!]), 'replace', SOURCES)
		expect(out.placed).toBe(1)
		expect(out.droppedOps[0]).toMatch(/pick 1 "lost words": its clip is no longer in the project/)
	})

	it('lays a pick from a camera-group clip as the group: its angle on the main track, the group sound under it', () => {
		const doc = makeDoc()
		const group: MulticamGroup = {
			id: 'g1', name: 'Interview', soundAssetId: 'b', createdAt: 0,
			members: [
				{ assetId: 'b', name: 'Cam 1', offset: 0, rate: 1, sync: { method: 'reference', confidence: 'strong', driftPpm: 0 } },
				{ assetId: 'a', name: 'Cam 2', offset: 2, rate: 1, sync: { method: 'audio', confidence: 'strong', driftPpm: 0 } }
			]
		}
		doc.multicams = [group]
		const pick = pickFromWords('a', A, 1, 4)!
		const out = buildStoryPlacement(doc, story([pick]), 'replace', SOURCES)
		expect(out.placed).toBe(1)
		const r = placeRange(pick, A, 60, SOURCES.a.silences!)
		const shots = out.diff.addItems!.filter((i) => i.trackId === 'v1')
		const sounds = out.diff.addItems!.filter((i) => i.multicam?.role === 'sound')
		expect(shots).toHaveLength(1)
		expect(shots[0]).toMatchObject({ sourceAssetId: 'a', timelineStart: 0, muted: true, multicam: { groupId: 'g1', role: 'shot' } })
		expect(shots[0].in).toBeCloseTo(r.in, 3)
		expect(shots[0].out).toBeCloseTo(r.out, 3)
		// The group's sound is file b, two seconds earlier on its own clock; A1 holds the music bed, so a new lane is made.
		expect(sounds).toHaveLength(1)
		expect(sounds[0].sourceAssetId).toBe('b')
		expect(sounds[0].in).toBeCloseTo(r.in + 2, 3)
		expect(out.diff.addTracks).toHaveLength(1)
		expect(sounds[0].trackId).toBe(out.diff.addTracks![0].id)
	})

	it('replacing takes the group sound that played under the group shots it removes', () => {
		const doc = makeDoc()
		doc.timeline = [
			{ id: 'shot', trackId: 'v1', sourceAssetId: 'a', timelineStart: 0, in: 0, out: 5, speed: 1, preservePitch: true, duration: 5, muted: true, multicam: { groupId: 'g1', role: 'shot' } },
			{ id: 'snd', trackId: 'a1', sourceAssetId: 'b', timelineStart: 0, in: 2, out: 7, speed: 1, preservePitch: true, duration: 5, multicam: { groupId: 'g1', role: 'sound' } },
			{ id: 'other', trackId: 'a1', sourceAssetId: 'music', timelineStart: 20, in: 0, out: 5, speed: 1, preservePitch: true, duration: 5 }
		]
		expect(itemsToReplace(doc, mainVideoTrack(doc)!).map((i) => i.id)).toEqual(['shot', 'snd'])
	})
})

describe('cutting a pick at the sound', () => {
	/** An envelope at 10 ms: -60 dB of room, with loud stretches where given (seconds). */
	const envelopeOf = (sec: number, loud: Array<[number, number, number]>): { hopSec: number; db: Float32Array } => {
		const db = new Float32Array(Math.round(sec / 0.01)).fill(-60)
		for (const [a, b, level] of loud) for (let i = Math.round(a / 0.01); i < Math.round(b / 0.01); i++) db[i] = level
		return { hopSec: 0.01, db }
	}
	const ws = words([[1.0, 1.3, 'before'], [2.0, 2.4, 'first'], [2.45, 2.9, 'middle'], [3.0, 3.5, 'last'], [4.5, 4.8, 'after']])

	it('opens at the latest near-quietest frame before the first word, a hundredth early', async () => {
		const { refineIn } = await import('./place')
		// Speech of the word before runs to 1.5; quiet (with one -62 dB dip at 1.7) until the word at 1.95.
		const env = envelopeOf(6, [[1.0, 1.5, -20], [1.7, 1.71, -61], [1.95, 2.4, -18]])
		// Window [max(1.08, 1.4), 1.99]: the -61 frame is the minimum, but the -60 frames up to 1.94 are within 1.5 dB.
		expect(refineIn(env, ws[1], ws[0])).toBeCloseTo(1.94 - 0.01, 3)
		// A word that starts too soon after the one before leaves no window.
		expect(refineIn(env, { text: 'x', start: 1.05, end: 1.2 }, ws[0])).toBeNull()
	})

	it('closes where the last word\'s final peak has fallen 20 dB, plus 0.03 s, never past the window', async () => {
		const { refineOut } = await import('./place')
		// "last" sounds from 3.0 with a final peak at 3.42 and a tail fading to room by 3.6.
		const env = envelopeOf(6, [[3.0, 3.4, -20], [3.4, 3.43, -12], [3.43, 3.5, -25], [3.5, 3.55, -35], [4.5, 4.8, -15]])
		const out = refineOut(env, ws[3], ws[4])!
		// Peak frame 3.42 (-12 dB); the first frame below -32 dB is 3.50 (-35): out = 3.53.
		expect(out).toBeCloseTo(3.53, 3)
		// Without a next word the window ends 1.4 s after the word starts; with sound to the end it stops there.
		const ringing = envelopeOf(6, [[3.0, 6, -15]])
		expect(refineOut(ringing, ws[3], undefined)).toBeCloseTo(4.4, 3)
	})

	it('refines placeRange only when the sound is there, and places with it', async () => {
		const { refineRange } = await import('./place')
		const pick = pickFromWords('a', ws, 1, 3)!
		const base = placeRange(pick, ws, 6)
		expect(refineRange(pick, ws, base, null, 6)).toEqual(base)
		const env = envelopeOf(6, [[1.0, 1.5, -20], [1.95, 3.4, -18], [3.4, 3.43, -12], [3.5, 3.55, -35], [4.5, 4.8, -15]])
		const refined = refineRange(pick, ws, base, env, 6)
		expect(refined.in).toBeCloseTo(1.93, 3)
		// The end keeps placeRange's edge: refined ends lost words in the 24 Nov harness
		expect(refined.out).toBe(base.out)
		const doc = makeDoc()
		doc.media[0] = { ...doc.media[0], metadata: { duration: 6 } as MediaAsset['metadata'] }
		const out = buildStoryPlacement(doc, story([pick]), 'replace', { a: { words: ws, silences: null, envelope: env } })
		expect(out.diff.addItems![0]).toMatchObject({ in: refined.in, out: refined.out })
	})
})
