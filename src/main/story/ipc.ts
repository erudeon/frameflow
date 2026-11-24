/**
 * The Story view's calls into main (docs/story.md). Placing a story goes through the same bridge and write queue an
 * agent's edits do, so a person's "Put on timeline" and an agent's apply_ops never interleave.
 */
import { app, ipcMain } from 'electron'
import type { Story } from '@shared/story'
import { rendererBridge } from '../mcp/rendererBridge'
import { LIVE_PROJECT, writeQueue } from '../mcp/writeQueue'
import { commitStory } from './commit'
import {
	abortLocalTranscribe, getStoryWords, importAssetTranscript, readPicksFile, storyDefaults, transcribeAssetLocally, writePicksFile
} from './service'

const message = (error: any) => error?.message || String(error)

export function registerStoryIpc(): void {
	ipcMain.handle('story-get-words', (_event, { threadId, assetId }: { threadId: string; assetId: string }) =>
		getStoryWords(String(threadId), String(assetId)))

	ipcMain.handle('story-import-transcript', (_event, { threadId, assetId, filePath }: { threadId: string; assetId: string; filePath: string }) =>
		importAssetTranscript(String(threadId), String(assetId), String(filePath || '')))

	ipcMain.handle('story-transcribe-local', (event, { threadId, assetId }: { threadId: string; assetId: string }) =>
		transcribeAssetLocally(String(threadId), String(assetId), {
			userDataDir: app.getPath('userData'),
			onProgress: (percent, label) => {
				if (!event.sender.isDestroyed()) event.sender.send('story-transcribe-progress', { threadId, assetId, percent, label })
			}
		}))

	ipcMain.handle('story-abort-transcribe', (_event, { threadId, assetId }: { threadId: string; assetId: string }) =>
		abortLocalTranscribe(String(threadId), String(assetId)))

	ipcMain.handle('story-place', async (_event, { threadId, story, mode }: { threadId: string; story: Story; mode?: 'replace' | 'append' }) => {
		try {
			if (!story || !Array.isArray(story.picks)) return { placed: 0, notes: [], droppedOps: [], error: 'No story to place.' }
			return await writeQueue.run(LIVE_PROJECT, async () => {
				const project = await rendererBridge.getLiveProject()
				if (!project || project.threadId !== threadId) {
					return { placed: 0, notes: [], droppedOps: [], error: 'That project is not the one open in the editor.' }
				}
				const result = await commitStory(rendererBridge, project, story, mode === 'append' ? 'append' : 'replace', { name: 'Story', sessionId: 'story-view' })
				if (!result.ok) return { placed: 0, notes: [], droppedOps: result.droppedOps ?? [], error: result.error }
				return {
					placed: result.placed, removed: result.removed, notes: result.notes, droppedOps: result.droppedOps,
					revisionId: result.outcome.revisionId, revisionSeq: result.outcome.revisionSeq, fromSec: result.fromSec, toSec: result.toSec
				}
			})
		} catch (error) {
			return { placed: 0, notes: [], droppedOps: [], error: message(error) }
		}
	})

	ipcMain.handle('story-read-picks', (_event, filePath: string) => readPicksFile(String(filePath || '')))
	ipcMain.handle('story-write-picks', (_event, { filePath, data }: { filePath: string; data: unknown }) => writePicksFile(String(filePath || ''), data))
	ipcMain.handle('story-defaults', () => storyDefaults())
}
