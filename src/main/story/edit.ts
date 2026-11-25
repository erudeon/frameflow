/**
 * How an agent writes stories (set_story, add_picks): picks named by clip and source seconds, or by the words said,
 * resolved against the clip's words; and the write itself, which refuses a stale `rev`, keeps the previous picks in
 * the story's history and bumps `rev`. Pure, so the rules are tested without an editor.
 */
import { newPickId, type ClipTag, type Story, type StoryPick, type Word } from '@shared/story'
import type { MediaAsset } from '@shared/types'

/** One pick as an agent asks for it. */
export interface PickRequest {
	asset?: string
	in?: number
	out?: number
	/** The words said, as search_moments or get_words show them. "first words ... last words" spans a longer run. */
	quote?: string
	speaker?: string
	take?: string
	note?: string
	/** Camera groups: lock the pick to one camera (1-based number or name). */
	angle?: string | number
	/** Camera groups: cut to a camera from `at` (SOURCE seconds of the pick's clip). */
	cuts?: Array<{ at: number; angle: string | number }>
}

export const HISTORY_KEEP = 10

const norm = (t: string) => t.normalize('NFKC').toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const tokens = (t: string) => norm(t).split(' ').filter(Boolean)
const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`

/** Every place a run of words occurs in a clip's words, as [first, last] word indexes. */
export function findQuote(words: Word[], quote: string): Array<[number, number]> {
	const said = words.map((w) => tokens(w.text))
	// A word token list, with the index of the word each token came from ("can't" stays one token, "e-mail" two).
	const flat: { tok: string; word: number }[] = []
	said.forEach((toks, i) => toks.forEach((tok) => flat.push({ tok, word: i })))
	const seq = (want: string[], from = 0, until = flat.length): number[] => {
		const hits: number[] = []
		if (!want.length) return hits
		for (let i = from; i + want.length <= until; i++) {
			let ok = true
			for (let k = 0; k < want.length; k++) if (flat[i + k].tok !== want[k]) { ok = false; break }
			if (ok) hits.push(i)
		}
		return hits
	}
	const parts = quote.split(/\.\.\.|…/).map(tokens).filter((p) => p.length)
	if (!parts.length) return []
	if (parts.length === 1) {
		return seq(parts[0]).map((i) => [flat[i].word, flat[i + parts[0].length - 1].word])
	}
	// "first words ... last words": the nearest end after each start, within two minutes of speech.
	const head = parts[0], tail = parts[parts.length - 1]
	const out: Array<[number, number]> = []
	for (const i of seq(head)) {
		const startWord = flat[i].word
		const ends = seq(tail, i + head.length).filter((j) => words[flat[j].word].start - words[startWord].start <= 120)
		if (ends.length) out.push([startWord, flat[ends[0] + tail.length - 1].word])
	}
	return out
}

export interface ResolveContext {
	media: MediaAsset[]
	/** Resolve an asset reference (id or file name); throws a readable error for an unknown one. */
	resolveAsset: (ref: string) => MediaAsset
	/** A clip's words in SOURCE seconds, or undefined when it has no transcript. */
	words: (assetId: string) => Promise<Word[] | undefined>
	tags?: Record<string, ClipTag>
}

/**
 * Picks from requests. Every request is checked before any is returned: one that names nothing, or a quote found in
 * no clip or in several places, makes the whole call fail with every problem listed.
 */
export async function resolvePicks(requests: PickRequest[], ctx: ResolveContext): Promise<StoryPick[]> {
	const problems: string[] = []
	const picks: StoryPick[] = []
	for (const [n, req] of requests.entries()) {
		const what = `pick ${n + 1}`
		try {
			const meta = (assetId: string) => ({
				speaker: req.speaker ?? ctx.tags?.[assetId]?.speaker,
				take: req.take ?? ctx.tags?.[assetId]?.take,
				...(req.note ? { note: req.note } : {}),
				...(req.angle != null && req.angle !== '' ? { angle: req.angle } : {}),
				...(req.cuts?.length ? { cuts: req.cuts.map((c) => ({ at: Number(c.at), angle: c.angle })) } : {})
			})
			if (req.quote && req.quote.trim()) {
				const candidates = req.asset ? [ctx.resolveAsset(req.asset)] : ctx.media.filter((a) => a.kind !== 'image')
				const hits: { asset: MediaAsset; words: Word[]; at: [number, number] }[] = []
				for (const asset of candidates) {
					const words = await ctx.words(asset.id)
					if (!words?.length) continue
					let found = findQuote(words, req.quote)
					// Narrowed by in/out when they are given with a quote.
					if (typeof req.in === 'number') found = found.filter(([a]) => words[a].start >= req.in! - 0.5)
					if (typeof req.out === 'number') found = found.filter(([, b]) => words[b].end <= req.out! + 0.5)
					for (const at of found) hits.push({ asset, words, at })
				}
				if (!hits.length) {
					problems.push(`${what}: "${req.quote}" is not in ${req.asset ? `${candidates[0].name}'s words` : 'any clip\'s words'} (get_words shows what each clip says)`)
					continue
				}
				if (hits.length > 1) {
					const where = hits.slice(0, 6).map((h) => `${h.asset.name} at ${clock(h.words[h.at[0]].start)}`).join('; ')
					problems.push(`${what}: "${req.quote}" is said in ${hits.length} places (${where}${hits.length > 6 ? '; …' : ''}). Give asset, or in/out, to choose one.`)
					continue
				}
				const [{ asset, words, at }] = hits
				picks.push(fromWords(asset.id, words, at[0], at[1], meta(asset.id)))
				continue
			}
			if (!req.asset || typeof req.in !== 'number' || typeof req.out !== 'number') {
				problems.push(`${what}: give asset with in and out (SOURCE seconds), or a quote`)
				continue
			}
			if (!(req.out > req.in)) {
				problems.push(`${what}: out (${req.out}) must be after in (${req.in})`)
				continue
			}
			const asset = ctx.resolveAsset(req.asset)
			const words = await ctx.words(asset.id)
			if (!words?.length) {
				// No transcript: the pick keeps the given edges and has no words to show.
				picks.push({ id: newPickId(), assetId: asset.id, in: req.in, out: req.out, text: '', ...meta(asset.id) })
				continue
			}
			let a = -1, b = -1
			words.forEach((w, i) => {
				const mid = (w.start + w.end) / 2
				if (mid >= req.in! - 0.02 && mid <= req.out! + 0.02) { if (a < 0) a = i; b = i }
			})
			if (a < 0) {
				problems.push(`${what}: no words are said in ${asset.name} between ${clock(req.in)} and ${clock(req.out)}`)
				continue
			}
			picks.push(fromWords(asset.id, words, a, b, meta(asset.id)))
		} catch (e: any) {
			problems.push(`${what}: ${e?.message || e}`)
		}
	}
	if (problems.length) throw new Error(`Nothing was changed:\n- ${problems.join('\n- ')}`)
	return picks
}

function fromWords(assetId: string, words: Word[], a: number, b: number, meta: Partial<StoryPick>): StoryPick {
	return {
		id: newPickId(), assetId, in: words[a].start, out: words[b].end, wordIn: a, wordOut: b,
		text: words.slice(a, b + 1).map((w) => w.text).join(' '),
		...Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined))
	}
}

/** A story by id, or by name (case and spacing ignored). */
export function findStory(stories: Story[], ref: string): Story | undefined {
	const want = String(ref || '').trim()
	return stories.find((s) => s.id === want) ?? stories.find((s) => s.name.trim().toLowerCase() === want.toLowerCase())
}

/**
 * Write a story's picks: `set` replaces them (creating the story when `ref` names none), `append` adds to them. The
 * previous picks go onto the story's history (newest first, ten kept) and `rev` goes up by one. A `rev` older than the
 * story's is refused: someone (the person, or another agent) changed it since it was read.
 */
export function writeStory(
	stories: Story[],
	ref: string,
	picks: StoryPick[],
	mode: 'set' | 'append',
	opts: { rev?: number; name?: string; by?: 'agent' | 'person'; now?: number } = {}
): { stories: Story[]; story: Story; created: boolean } {
	const now = opts.now ?? Date.now()
	const existing = findStory(stories, ref)
	if (!existing) {
		if (mode === 'append') throw new Error(`There is no story "${ref}". Stories: ${stories.map((s) => s.name).join(', ') || 'none'}. set_story makes one.`)
		const story: Story = {
			id: `st_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: (opts.name || ref || 'Story').trim(),
			picks, rev: 1, history: [], createdAt: now, updatedAt: now
		}
		return { stories: [...stories, story], story, created: true }
	}
	const current = existing.rev ?? 0
	if (typeof opts.rev === 'number' && opts.rev < current) {
		throw new Error(`"${existing.name}" changed since you read it (it is at rev ${current}, you sent rev ${opts.rev}). Nothing was changed: read get_stories again and send your picks against rev ${current}.`)
	}
	const history = [{ at: now, by: opts.by ?? 'agent', picks: existing.picks }, ...(existing.history ?? [])].slice(0, HISTORY_KEEP)
	const story: Story = {
		...existing,
		name: opts.name?.trim() || existing.name,
		picks: mode === 'set' ? picks : [...existing.picks, ...picks],
		rev: current + 1,
		history,
		updatedAt: now
	}
	return { stories: stories.map((s) => (s.id === existing.id ? story : s)), story, created: false }
}
