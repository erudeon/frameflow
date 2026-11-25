import { describe, expect, it } from 'vitest'
import type { MediaAsset } from '@shared/types'
import type { Story, Word } from '@shared/story'
import { findQuote, resolvePicks, writeStory, HISTORY_KEEP } from './edit'

const w = (text: string, start: number): Word => ({ text, start, end: start + 0.3 })
const A: Word[] = ['It', 'depends.', 'If', 'the', 'request', 'fits', 'the', 'vibe,', 'of', 'course.'].map((t, i) => w(t, 10 + i * 0.4))
const B: Word[] = ['Of', 'course', 'it', 'depends.'].map((t, i) => w(t, 3 + i * 0.4))
const media = [{ id: 'a', name: 'Bas take 1.mp4', kind: 'video' }, { id: 'b', name: 'Mila.mp4', kind: 'video' }] as MediaAsset[]
const ctx = {
	media,
	resolveAsset: (ref: string) => {
		const found = media.find((m) => m.id === ref || m.name === ref)
		if (!found) throw new Error(`No media "${ref}"`)
		return found
	},
	words: async (id: string) => ({ a: A, b: B } as Record<string, Word[]>)[id],
	tags: { a: { speaker: 'Bas', take: '1' } }
}

describe('finding a quote in a clip\'s words', () => {
	it('matches words regardless of case and punctuation', () => {
		expect(findQuote(A, 'if the request fits')).toEqual([[2, 5]])
		expect(findQuote(A, 'the')).toEqual([[3, 3], [6, 6]])
	})
	it('spans "first words ... last words"', () => {
		expect(findQuote(A, 'If the … of course')).toEqual([[2, 9]])
		expect(findQuote(A, 'it depends ... nowhere')).toEqual([])
	})
})

describe('resolving picks an agent asks for', () => {
	it('snaps in/out to the words said between them, and fills speaker and take from the clip tags', async () => {
		const [pick] = await resolvePicks([{ asset: 'a', in: 10.75, out: 12.3 }], ctx)
		expect(pick).toMatchObject({ assetId: 'a', wordIn: 2, wordOut: 5, text: 'If the request fits', speaker: 'Bas', take: '1' })
		expect(pick.in).toBe(A[2].start)
		expect(pick.out).toBe(A[5].end)
	})
	it('finds a quote in whichever clip says it, and refuses one said in several places, naming them', async () => {
		const [pick] = await resolvePicks([{ quote: 'the request fits the vibe' }], ctx)
		expect(pick.assetId).toBe('a')
		await expect(resolvePicks([{ quote: 'it depends' }], ctx)).rejects.toThrow(/said in 2 places \(Bas take 1\.mp4 at 0:10\.0; Mila\.mp4 at 0:03\.8\)/)
		const [chosen] = await resolvePicks([{ quote: 'it depends', asset: 'Mila.mp4' }], ctx)
		expect(chosen.assetId).toBe('b')
	})
	it('checks every pick before returning any, and lists every problem', async () => {
		await expect(resolvePicks([{ asset: 'a', in: 10, out: 11 }, { quote: 'never said' }, { asset: 'zzz', in: 1, out: 2 }], ctx))
			.rejects.toThrow(/Nothing was changed:\n- pick 2: "never said" is not in any clip's words[\s\S]*pick 3: No media "zzz"/)
	})
})

describe('writing a story', () => {
	const picks = [{ id: 'p1', assetId: 'a', in: 1, out: 2, text: 'one' }]
	it('creates a story when the name is new', () => {
		const out = writeStory([], 'Q1 requests', picks, 'set', { now: 5 })
		expect(out.created).toBe(true)
		expect(out.story).toMatchObject({ name: 'Q1 requests', picks, rev: 1, history: [] })
	})
	it('keeps the picks before on the history (ten), bumps rev, and refuses a write against an older rev', () => {
		let stories: Story[] = [{ id: 's1', name: 'Q1', picks: [], rev: 3 }]
		for (let i = 0; i < 12; i++) stories = writeStory(stories, 'q1', [{ ...picks[0], id: `p${i}` }], 'set', { now: i }).stories
		expect(stories[0].rev).toBe(15)
		expect(stories[0].history).toHaveLength(HISTORY_KEEP)
		expect(stories[0].history![0]).toMatchObject({ by: 'agent', picks: [{ id: 'p10' }] })
		expect(() => writeStory(stories, 's1', picks, 'set', { rev: 14 })).toThrow(/changed since you read it \(it is at rev 15, you sent rev 14\)/)
		const appended = writeStory(stories, 's1', [{ ...picks[0], id: 'extra' }], 'append', { rev: 15 })
		expect(appended.story.picks.map((p) => p.id)).toEqual(['p11', 'extra'])
	})
	it('will not append to a story that does not exist', () => {
		expect(() => writeStory([], 'nope', picks, 'append')).toThrow(/There is no story "nope"/)
	})
})
