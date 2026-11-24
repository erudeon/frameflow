/**
 * Putting a story on the timeline (docs/story.md, "Put on timeline"): each pick becomes a clip on the main video track,
 * back to back, with handles from placeRange so no word is clipped. A pick from a clip that belongs to a camera group
 * is laid as that group (its main sound and the pick's own angle), like placeMulticam.
 *
 * Pure: the caller hands in the document and each clip's words and measured quiet, and commits the diff as one turn.
 */
import { v4 as uuidv4 } from 'uuid'
import type { EditorDocument, EditorOps, TimelineDiff, TimelineItem, Track } from '@shared/types'
import { chooseCameraCuts, CAMERA_CUTS, pauseCutPoints, pickWordRange, placeRange, type Story, type StoryPick, type Word } from '@shared/story'
import { computeContentEnd, itemEnd, TIMELINE_DIFF_SCHEMA_VERSION } from '@shared/timeline'
import { anglesOf, cameraOf, cameraSpans, memberOf, placeGroup, planAngleSwitches, resolveAngle, soundSpan, toGroupTime, toSourceTime, type Camera } from '@shared/multicam'
import type { MulticamGroup, MulticamMember } from '@shared/types'
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

// ---------------------------------------------------------------- cutting between cameras

/** "auto": cut between the group's cameras at pauses. "keep": every pick on the camera its words come from. */
export type CameraMode = 'auto' | 'keep'

/** One cut inside a pick: from `at` (SOURCE seconds of the pick's clip) it shows angle `angle` (1-based). */
export interface CameraSwitch { at: number; angle: number }

type Media = Parameters<typeof anglesOf>[1]

/** A member's sync is good enough to cut to without a person looking: strong, the reference, or set by hand. */
const trusted = (m: MulticamMember) => m.sync.confidence === 'strong' || m.sync.method === 'reference' || m.sync.method === 'manual'

const clockOf = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`

/**
 * Whether `camera` recorded all of the group stretch [ga, gb], file joins allowed, and how well its files there are
 * synced. Null when it recorded all of it with trusted sync; else why not.
 */
export function cameraGap(camera: Camera, media: Media, ga: number, gb: number): { reason: 'missing' | 'weak'; files: string[] } | null {
	const spans = cameraSpans(camera, media).filter((sp) => sp.end > ga + 1e-6 && sp.start < gb - 1e-6)
	let t = ga
	for (const sp of spans) {
		if (sp.start > t + 0.04) break
		t = Math.max(t, sp.end)
	}
	if (t < gb - 0.04) return { reason: 'missing', files: [] }
	const weak = spans.filter((sp) => !trusted(sp.member))
	return weak.length ? { reason: 'weak', files: weak.map((sp) => sp.member.name) } : null
}

/**
 * The camera cuts inside one pick from a camera group, in SOURCE seconds of the pick's clip, given where it is cut
 * (`range`). Precedence: the pick's own `cuts`, then its `angle` lock, then the mode. "auto" cuts at pauses
 * (chooseCameraCuts), switching to another camera only for a stretch it recorded all of with a trusted sync, and back
 * to the pick's own camera (the one that recorded its words) after; with three or more cameras the others take turns.
 */
export function cameraSwitchesFor(
	pick: StoryPick, group: MulticamGroup, media: Media, member: MulticamMember, range: { in: number; out: number },
	source: Pick<WordSource, 'words' | 'silences'> | undefined, mode: CameraMode, opts: { minShotSec?: number } = {}
): { switches: CameraSwitch[]; notes: string[] } {
	const angles = anglesOf(group, media)
	const number = (cam?: Camera) => (cam ? angles.findIndex((c) => c.key === cam.key) + 1 : 0)
	const own = cameraOf(group, media, member.assetId)
	const notes: string[] = []
	const angleNo = (ref: string | number, what: string): number | null => {
		const cam = resolveAngle(group, media, ref)
		if (!cam) { notes.push(`${what}: there is no camera "${ref}" (cameras: ${angles.map((c, i) => `${i + 1} ${c.name}`).join(', ')})`); return null }
		return number(cam)
	}
	const words = source?.words ?? []
	/** A cut asked for at `at`: just before the word starting nearest it (within 0.4 s), else where it was asked. */
	const snap = (at: number) => {
		let best: Word | undefined
		for (const w of words) if (Math.abs(w.start - at) <= 0.4 && (!best || Math.abs(w.start - at) < Math.abs(best.start - at))) best = w
		return best ? Math.max(range.in, best.start - CAMERA_CUTS.lead) : at
	}

	if (pick.cuts?.length) {
		const switches: CameraSwitch[] = []
		if (pick.angle != null) { const n = angleNo(pick.angle, 'angle'); if (n) switches.push({ at: range.in, angle: n }) }
		for (const c of [...pick.cuts].sort((a, b) => a.at - b.at)) {
			const at = snap(c.at)
			if (at <= range.in + 0.05 || at >= range.out - 0.05) { notes.push(`cut at ${clockOf(c.at)}: outside the pick (${clockOf(range.in)}–${clockOf(range.out)})`); continue }
			const n = angleNo(c.angle, `cut at ${clockOf(c.at)}`)
			if (n) switches.push({ at: Math.round(at * 1000) / 1000, angle: n })
		}
		return { switches, notes }
	}
	if (pick.angle != null) {
		const n = angleNo(pick.angle, 'angle')
		return { switches: n && n !== number(own) ? [{ at: range.in, angle: n }] : [], notes }
	}
	if (mode === 'keep' || angles.length < 2 || !own) return { switches: [], notes }

	const others = angles.filter((c) => c.key !== own.key)
	const bounds = [range.in, ...chooseCameraCuts(pauseCutPoints(words, range, source?.silences), range, opts), range.out]
	const g = (t: number) => toGroupTime(member, t)
	const switches: CameraSwitch[] = []
	const skipped = new Map<string, string>()
	let current: Camera = own
	const isOwn = (c: Camera) => c.key === own.key
	let turn = 0
	for (let k = 1; k < bounds.length - 1; k++) {
		const [a, b] = [bounds[k], bounds[k + 1]]
		if (!isOwn(current)) { switches.push({ at: a, angle: number(own) }); current = own; continue }
		// The next camera in turn that recorded all of this stretch with a trusted sync.
		let chosen: Camera | undefined
		for (let i = 0; i < others.length && !chosen; i++) {
			const cam = others[(turn + i) % others.length]
			const gap = cameraGap(cam, media, g(a), g(b))
			if (!gap) { chosen = cam; turn = (turn + i + 1) % others.length }
			else if (gap.reason === 'weak') skipped.set(cam.name, `${cam.name} is synced weakly here (${gap.files.join(', ')}), so the cut is not made automatically: check it with get_angles, fix it with nudgeAngle, or set the pick's angle or cuts`)
			else if (!skipped.has(cam.name)) skipped.set(cam.name, `${cam.name} was not recording all of ${clockOf(a)}–${clockOf(b)}`)
		}
		if (chosen) { switches.push({ at: a, angle: number(chosen) }); current = chosen }
	}
	notes.push(...skipped.values())
	return { switches, notes }
}

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
	/** Every pick from a camera group: its shots in order, each with the camera it shows. */
	cameraShots: Array<{ pick: number; group: string; shots: Array<{ atSec: number; sourceSec: number; angle: number; camera: string }>; notes?: string[] }>
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
	opts: {
		by: string; turnId?: string; speakerOf?: (pick: StoryPick) => string | undefined; newId?: () => string
		/** How picks from camera groups use the cameras (default "auto"). */
		cameras?: CameraMode
		minShotSec?: number
	} = { by: 'Story' }
): StoryPlacement {
	const newId = opts.newId ?? uuidv4
	const notes: string[] = []
	const dropped: string[] = []
	const track = mainVideoTrack(doc)
	if (!track) {
		return { diff: { schemaVersion: TIMELINE_DIFF_SCHEMA_VERSION }, placed: 0, removed: 0, droppedOps: ['There is no unlocked, visible video track to put the story on.'], notes, fromSec: 0, toSec: 0, cameraShots: [] }
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
	const cameraShots: StoryPlacement['cameraShots'] = []

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
				if (!('reason' in placed) && placed.items.some((i) => i.trackId === track.id)) {
					let items = placed.items
					const at = cursor
					const tl = (src: number) => at + (toGroupTime(member, src) - from) / sound.rate
					const cams = cameraSwitchesFor(pick, group, doc.media, member, range, source, opts.cameras ?? 'auto', { minShotSec: opts.minShotSec })
					const pickNotes = cams.notes.map((n) => `${what}: ${n}`)
					if (cams.switches.length) {
						const plan = planAngleSwitches(items, group, cams.switches.map((sw) => ({ atSec: tl(sw.at), angle: sw.angle })), doc.media, newId, at + length)
						const updates = new Map(plan.updates.map((u) => [u.id, u]))
						const removed = new Set(plan.removeIds)
						items = [...items.filter((i) => !removed.has(i.id)).map((i) => (updates.has(i.id) ? { ...i, ...updates.get(i.id) } : i)), ...plan.adds]
						pickNotes.push(...plan.dropped.map((d) => `${what}: ${d}`), ...plan.notes.map((n) => `${what}: ${n}`))
					}
					const angles = anglesOf(group, doc.media)
					const shots = items.filter((i) => i.trackId === track.id).map((i) => ({ ...i, label })).sort((x, y) => x.timelineStart - y.timelineStart)
					const sounds = items.filter((i) => i.trackId !== track.id)
					groupItems.push(...shots, ...sounds)
					groupPicks++
					// Shots in order with their camera; a camera's file join is not a cut, so a run on one camera is one shot.
					const runs: StoryPlacement['cameraShots'][number]['shots'] = []
					for (const shot of shots) {
						const cam = cameraOf(group, doc.media, shot.sourceAssetId)
						const n = cam ? angles.findIndex((c) => c.key === cam.key) + 1 : 0
						if (runs.at(-1)?.angle === n) continue
						const src = toSourceTime(member, from + (shot.timelineStart - at) * sound.rate)
						runs.push({ atSec: round3(shot.timelineStart), sourceSec: round3(src), angle: n, camera: cam?.name ?? '?' })
					}
					cameraShots.push({ pick: n + 1, group: group.name, shots: runs, ...(pickNotes.length ? { notes: pickNotes } : {}) })
					notes.push(...pickNotes)
					cursor = Math.max(cursor + length, ...items.map(itemEnd))
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
		toSec: round3(cursor),
		cameraShots
	}
}

const round3 = (x: number) => Math.round(x * 1000) / 1000
