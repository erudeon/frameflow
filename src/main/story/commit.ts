/**
 * "Put on timeline" as one turn: the story's picks are placed (place.ts) against the live document and committed the
 * way apply_ops commits, so the result is one revision the person can switch away from. Used by the Story view (IPC)
 * and by the place_story tool; Electron-free, it reaches the editor only through the bridge.
 */
import { randomUUID } from 'node:crypto'
import type { Story } from '@shared/story'
import type { PromptTurn } from '@shared/types'
import type { ApplyOutcome, EditorBridge, LiveProject } from '../mcp/bridge'
import { buildStoryPlacement, type PlaceMode, type WordSource } from './place'

export type StoryCommit =
	| { ok: true; placed: number; removed: number; droppedOps: string[]; notes: string[]; fromSec: number; toSec: number; outcome: Extract<ApplyOutcome, { ok: true }> }
	| { ok: false; error: string; droppedOps?: string[] }

export async function commitStory(
	bridge: EditorBridge,
	project: LiveProject,
	story: Story,
	mode: PlaceMode,
	agent: NonNullable<PromptTurn['agent']>
): Promise<StoryCommit> {
	if (!story.picks.length) return { ok: false, error: `"${story.name}" has no picks to place.` }
	const assetIds = [...new Set(story.picks.map((p) => p.assetId))].filter((id) => project.doc.media.some((a) => a.id === id))
	const sources: Record<string, WordSource | undefined> = {}
	await Promise.all(assetIds.map(async (id) => {
		sources[id] = await bridge.storyWords(project, id, { envelope: true }).catch(() => undefined)
	}))
	const tags = project.doc.clipTags
	const turnId = randomUUID()
	const placement = buildStoryPlacement(project.doc, story, mode, sources, {
		by: agent.name, turnId, speakerOf: (p) => p.speaker ?? tags?.[p.assetId]?.speaker
	})
	if (!placement.placed) {
		return { ok: false, error: `Nothing from "${story.name}" could be placed.`, droppedOps: placement.droppedOps }
	}
	const turn: PromptTurn = {
		id: turnId,
		prompt: `${agent.name}: put "${story.name}" on the timeline (${mode})`,
		baseStepId: project.doc.historyRef?.currentStepId || '',
		status: 'completed',
		diff: placement.diff,
		rationale: `Story: ${story.name}`,
		droppedOps: placement.droppedOps.length ? placement.droppedOps : undefined,
		notes: placement.notes.length ? placement.notes : undefined,
		agent,
		createdAt: Date.now()
	}
	const outcome = await bridge.commitTurn({ threadId: project.threadId, turn })
	if (!outcome.ok) return { ok: false, error: outcome.error, droppedOps: placement.droppedOps }
	return {
		ok: true, placed: placement.placed, removed: placement.removed, outcome,
		droppedOps: [...placement.droppedOps, ...outcome.pruned],
		notes: [...placement.notes, ...(outcome.shifted ?? [])],
		fromSec: placement.fromSec, toSec: placement.toSec
	}
}
