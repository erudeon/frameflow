/**
 * Putting a story on the timeline (docs/story.md, "Put on timeline"): each pick becomes a clip on the main video track,
 * back to back, with handles from placeRange so no word is clipped. A pick from a clip that belongs to a camera group
 * is laid as that group (its main sound and the pick's own angle), like placeMulticam.
 *
 * Pure: the caller hands in the document and each clip's words and measured quiet, and commits the diff as one turn.
 */
import { v4 as uuidv4 } from 'uuid'
import type { EditorDocument, EditorOps, TimelineDiff, TimelineItem, Track } from '@shared/types'
import { pickWordRange, placeRange, type Story, type StoryPick, type Word } from '@shared/story'
import { computeContentEnd, itemEnd, TIMELINE_DIFF_SCHEMA_VERSION } from '@shared/timeline'
import { cameraOf, memberOf, placeGroup, soundSpan, toGroupTime } from '@shared/multicam'
import { nextTrackName, nextTrackOrder } from '@shared/tracks'
import { opsToDiff } from '../editor/ops'

export interface WordSource {
	words: Word[]
	/** Measured quiet in SOURCE seconds; null when it could not be measured. */
	silences: { start: number; end: number }[] | null
	/** The words were shared out over sentence times (no word timings): edges are rough. */
	estimated?: boolean
	/** The clip's loudness every 10 ms (envelope.ts): edges are refined against it when present. */
	envelope?: Envelope | null
}

/** RMS level in dB of every `hopSec`, frame i centred on i × hopSec. */
export interface Envelope {
	hopSec: number
	db: ArrayLike<number>
}

// ---------------------------------------------------------------- edges cut at the sound

/** Frames [f0, f1] covering seconds [lo, hi], clamped to the envelope; null when empty. */
function frames(env: Envelope, lo: number, hi: number): [number, number] | null {
	const f0 = Math.max(0, Math.ceil(lo / env.hopSec - 1e-9))
	const f1 = Math.min(env.db.length - 1, Math.floor(hi / env.hopSec + 1e-9))
	return f1 >= f0 ? [f0, f1] : null
}

/**
 * Where a pick opens: the quietest moment in [max(word before's start + 0.08, first word's start - 0.6),
 * first word's start - 0.01], the latest frame within 1.5 dB of that minimum (so it sits against the word, not back in
 * the pause), less 0.01 s. Null when the window is empty or not measured.
 */
export function refineIn(env: Envelope, first: Word, prev?: Word): number | null {
	const lo = Math.max(0, prev ? prev.start + 0.08 : 0, first.start - 0.6)
	const hi = first.start - 0.01
	const span = hi > lo ? frames(env, lo, hi) : null
	if (!span) return null
	let min = Infinity
	for (let i = span[0]; i <= span[1]; i++) min = Math.min(min, env.db[i])
	let best = span[0]
	for (let i = span[0]; i <= span[1]; i++) if (env.db[i] <= min + 1.5) best = i
	return Math.max(0, best * env.hopSec - 0.01)
}

/**
 * Where a pick closes. Window [last word's start + 0.15, next word's start - 0.01] (or + 1.4 s with no next word).
 * The last word's sound is the run of frames from its start that stays within 20 dB of the window's loud level (the
 * median of its top 30%), dips of up to 50 ms allowed; its last peak at or above that level is where the word's final
 * sound is, and the cut goes where the level has fallen 20 dB below that peak (or at the window's quietest frame after
 * the peak when it never does), plus 0.03 s, never past the window. Null when the window is empty or not measured.
 */
export function refineOut(env: Envelope, last: Word, next?: Word, duration?: number): number | null {
	const lo = last.start + 0.15
	let hi = next ? next.start - 0.01 : last.start + 1.4
	if (duration != null) hi = Math.min(hi, duration)
	const span = hi > lo ? frames(env, lo, hi) : null
	if (!span) return null
	const [f0, f1] = span
	const values: number[] = []
	for (let i = f0; i <= f1; i++) values.push(env.db[i])
	const top = values.sort((a, b) => b - a).slice(0, Math.max(1, Math.ceil(values.length * 0.3)))
	const loud = top.length % 2 ? top[(top.length - 1) / 2] : (top[top.length / 2 - 1] + top[top.length / 2]) / 2
	const floor = loud - 20

	// The last word's sound: contiguous from its start. Before it has been heard, a soft onset may take up to 0.2 s.
	const fs = Math.max(0, Math.round(last.start / env.hopSec))
	let bodyEnd = fs, dip = 0, heard = false
	for (let i = fs; i <= f1; i++) {
		if (env.db[i] >= floor) { bodyEnd = i; dip = 0; heard = true }
		else if (++dip > (heard ? 5 : 20)) break
	}
	let peak = -1
	for (let i = Math.max(f0, fs); i <= Math.min(bodyEnd, f1); i++) {
		const v = env.db[i]
		if (v >= loud && v >= (env.db[i - 1] ?? -Infinity) && v >= (env.db[i + 1] ?? -Infinity)) peak = i
	}
	if (peak < 0) {
		// No peak inside the window: the word's loudest moment, wherever it is.
		peak = fs
		for (let i = fs; i <= Math.min(bodyEnd, f1); i++) if (env.db[i] > env.db[peak]) peak = i
	}
	const target = env.db[peak] - 20
	for (let i = Math.max(peak, f0); i <= f1; i++) {
		if (env.db[i] < target) return Math.min(hi, i * env.hopSec + 0.03)
	}
	// It never falls that far: the quietest frame after the peak (a flat stretch to the window's end keeps it all).
	let quiet = Math.max(peak, f0)
	for (let i = quiet; i <= f1; i++) if (env.db[i] < env.db[quiet]) quiet = i
	return Math.min(hi, quiet * env.hopSec + 0.03)
}

/**
 * placeRange's edges, refined against the clip's sound. Without an envelope, or when a window is empty, that edge
 * stays as placeRange put it.
 */
export function refineRange(pick: StoryPick, words: Word[], range: { in: number; out: number }, env?: Envelope | null, duration?: number): { in: number; out: number } {
	const r = env && env.db.length ? pickWordRange(pick, words) : null
	if (!r || !env) return range
	const [a, b] = r
	// Start only, and only at a real pause (24 Nov harness: refined starts kept the first word 17/20 vs 14/20 on
	// phrase-boundary picks but 6/20 vs 10/20 mid-sentence; refined ends were worse everywhere, so the end keeps placeRange)
	const prev = words[a - 1]
	const atPause = !prev || words[a].start - prev.end >= 0.3
	const inT = atPause ? (refineIn(env, words[a], prev) ?? range.in) : range.in
	let outT = range.out
	if (duration != null) outT = Math.min(outT, duration)
	if (!(outT - inT > 0.05)) return range
	return { in: round3(inT), out: round3(outT) }
}

export type PlaceMode = 'replace' | 'append'

export interface StoryPlacement {
	diff: TimelineDiff
	/** Picks that became clips. */
	placed: number
	/** Items taken off the timeline first (replace mode). */
	removed: number
	droppedOps: string[]
	notes: string[]
	/** Timeline seconds the story covers once placed. */
	fromSec: number
	toSec: number
}

/** The track opsToDiff adds to: the lowest unlocked, visible video track. Kept identical so removes and adds agree. */
export function mainVideoTrack(doc: Pick<EditorDocument, 'tracks'>): Track | undefined {
	return [...doc.tracks].sort((a, b) => a.order - b.order).find((t) => t.kind === 'video' && !t.locked && !t.hidden)
}

const short = (text: string, n = 48) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text)

export function pickLabel(pick: StoryPick, speaker?: string): string {
	const words = pick.text ? `"${short(pick.text, 44)}"` : ''
	return [speaker, words].filter(Boolean).join(' · ') || 'Story pick'
}

/**
 * What a replace takes off the timeline: everything on the main video track, and the camera-group sound that played
 * under group shots being removed (a group's sound lives on an audio track of its own).
 */
export function itemsToReplace(doc: EditorDocument, track: Track): TimelineItem[] {
	const shots = doc.timeline.filter((i) => i.trackId === track.id)
	const groups = new Set(shots.map((s) => s.multicam?.groupId).filter(Boolean) as string[])
	const sounds = doc.timeline.filter((i) => i.multicam?.role === 'sound' && groups.has(i.multicam.groupId) &&
		shots.some((s) => s.multicam?.groupId === i.multicam!.groupId && i.timelineStart < itemEnd(s) - 1e-6 && itemEnd(i) > s.timelineStart + 1e-6))
	return [...shots, ...sounds]
}

export function buildStoryPlacement(
	doc: EditorDocument,
	story: Pick<Story, 'name' | 'picks'>,
	mode: PlaceMode,
	sources: Record<string, WordSource | undefined>,
	opts: { by: string; turnId?: string; speakerOf?: (pick: StoryPick) => string | undefined; newId?: () => string } = { by: 'Story' }
): StoryPlacement {
	const newId = opts.newId ?? uuidv4
	const notes: string[] = []
	const dropped: string[] = []
	const track = mainVideoTrack(doc)
	if (!track) {
		return { diff: { schemaVersion: TIMELINE_DIFF_SCHEMA_VERSION }, placed: 0, removed: 0, droppedOps: ['There is no unlocked, visible video track to put the story on.'], notes, fromSec: 0, toSec: 0 }
	}

	const removing = mode === 'replace' ? itemsToReplace(doc, track) : []
	const removedIds = new Set(removing.map((i) => i.id))
	const surviving = doc.timeline.filter((i) => !removedIds.has(i.id))
	const start = mode === 'replace' ? 0 : computeContentEnd(surviving.filter((i) => i.trackId === track.id))
	let cursor = start

	// Removals are NOT sent through opsToDiff: it ripples the rest of the track (this call's adds included) left by
	// what it removes, which would pull the picks off the positions worked out here. The adds are mapped against the
	// document without the removed items, and the removal rides in the same diff.
	const ops: EditorOps = { addClips: [] }
	const groupItems: TimelineItem[] = []
	const addedTracks: Track[] = []
	let estimatedClips = 0
	let rawEdges = 0
	let groupPicks = 0

	// A free audio lane for a group's sound over [from, to): the first unlocked audio track nothing else uses there.
	const audioLaneFor = (from: number, to: number): Track => {
		const busy = (t: Track) => [...surviving, ...groupItems].some((i) => i.trackId === t.id &&
			i.timelineStart < to - 1e-6 && itemEnd(i) > from + 1e-6)
		const lanes = [...doc.tracks, ...addedTracks].filter((t) => t.kind === 'audio' && !t.locked).sort((a, b) => a.order - b.order)
		const free = lanes.find((t) => !busy(t))
		if (free) return free
		const all = [...doc.tracks, ...addedTracks]
		const made: Track = {
			id: newId(), kind: 'audio', name: nextTrackName(all, 'audio'), order: nextTrackOrder(all, 'audio'),
			muted: false, locked: false, hidden: false, height: 64
		}
		addedTracks.push(made)
		return made
	}

	story.picks.forEach((pick, n) => {
		const what = `pick ${n + 1}${pick.text ? ` "${short(pick.text, 30)}"` : ''}`
		const asset = doc.media.find((a) => a.id === pick.assetId)
		if (!asset) {
			dropped.push(`${what}: its clip is no longer in the project`)
			return
		}
		const source = sources[asset.id]
		const duration = asset.metadata?.duration
		let range: { in: number; out: number }
		if (source?.words?.length) {
			range = refineRange(pick, source.words, placeRange(pick, source.words, duration, source.silences ?? undefined), source.envelope, duration)
			if (source.estimated) estimatedClips++
		} else {
			range = { in: Math.max(0, pick.in), out: duration != null ? Math.min(pick.out, duration) : pick.out }
			rawEdges++
		}
		if (!(range.out - range.in > 0.05)) {
			dropped.push(`${what}: it is too short to place (${(range.out - range.in).toFixed(2)}s)`)
			return
		}
		const label = pickLabel(pick, opts.speakerOf?.(pick))

		const group = (doc.multicams ?? []).find((g) => g.members.some((m) => m.assetId === asset.id))
		if (group) {
			const member = memberOf(group, asset.id)!
			const sound = memberOf(group, group.soundAssetId)
			const span = soundSpan(group, doc.media)
			const from = toGroupTime(member, range.in)
			const to = toGroupTime(member, range.out)
			const angle = asset.kind === 'video' ? cameraOf(group, doc.media, asset.id)?.name : undefined
			if (sound && span && from >= span.start - 0.01 && to <= span.end + 0.01) {
				const length = (Math.min(to, span.end) - Math.max(from, span.start)) / sound.rate
				const audio = audioLaneFor(cursor, cursor + length)
				const placed = placeGroup(group, doc.media, {
					videoTrackId: track.id, audioTrackId: audio.id, atSec: cursor, newId, angle: angle ?? undefined, from, to
				})
				if (!('reason' in placed) && placed.items.length) {
					const shots = placed.items.filter((i) => i.trackId === track.id).map((i) => ({ ...i, label }))
					const sounds = placed.items.filter((i) => i.trackId !== track.id)
					groupItems.push(...shots, ...sounds)
					groupPicks++
					cursor = Math.max(cursor + length, ...placed.items.map(itemEnd))
					return
				}
				notes.push(`${what}: placed as a plain clip, not as camera group "${group.name}" (${'reason' in placed ? placed.reason : 'nothing to place'}).`)
			} else {
				notes.push(`${what}: placed as a plain clip: that stretch is outside camera group "${group.name}"'s main sound.`)
			}
		}

		ops.addClips!.push({ assetId: asset.id, in: range.in, out: range.out, atSec: round3(cursor), label })
		cursor += range.out - range.in
	})

	const mapped = opsToDiff(ops, { ...doc, timeline: surviving }, { by: opts.by, turnId: opts.turnId })
	const diff = mapped.diff
	if (removing.length) diff.removeItemIds = [...removing.map((i) => i.id), ...(diff.removeItemIds ?? [])]
	// Each plain pick is at most one clip; a group pick may be several (a camera that split its recording into files).
	const plainPlaced = (diff.addItems ?? []).filter((i) => i.trackId === track.id).length
	if (groupItems.length) diff.addItems = [...(diff.addItems ?? []), ...groupItems]
	if (addedTracks.length) diff.addTracks = [...(diff.addTracks ?? []), ...addedTracks]

	if (rawEdges) notes.push(`${rawEdges} pick(s) had no word timings, so they were cut at their stored edges with no handles.`)
	if (estimatedClips) notes.push(`${estimatedClips} pick(s) come from a transcript without word timings: check their edges.`)
	if (removing.length) notes.push(`Replaced ${removing.length} item(s) on ${track.name}${removing.length > removing.filter((i) => i.trackId === track.id).length ? ' and their camera-group sound' : ''}.`)
	return {
		diff,
		placed: plainPlaced + groupPicks,
		removed: removing.length,
		droppedOps: [...dropped, ...mapped.droppedOps],
		notes: [...notes, ...mapped.notes],
		fromSec: round3(start),
		toSec: round3(cursor)
	}
}

const round3 = (x: number) => Math.round(x * 1000) / 1000
