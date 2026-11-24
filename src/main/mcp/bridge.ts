import type { DeliveryFormat, EditorDocument, EditorRevision, MediaAsset, PromptTurn } from '@shared/types'
import type { AudioAnalysis } from '@shared/audio'
import type { AudioInspection } from '@shared/audioFeatures'
import type { SoundRecipe } from '@shared/synth'
import type { TranscriptEntry } from '@shared/captions'
import type { AgentApplyOutcome } from '@shared/agentFeed'
import type { AudioProvenance, GenerateRequest, ProviderId, SpendPolicy } from '@shared/audioProviders'
import type { ObjectTrack, TrackShape } from '@shared/tracking'
import type { ClipTag, Story, Word } from '@shared/story'

/**
 * What the MCP tools need from the rest of the app, as an interface.
 *
 * The renderer's store owns the timeline (its 800ms autosave overwrites main's
 * copy), so every read asks it for the LIVE document and every write goes down
 * the same `editor-turn-update` path FrameFlow's own AI uses. The Electron
 * implementation lives in rendererBridge.ts; the integration test supplies a
 * fake, which is why nothing here imports Electron.
 */

export type RevisionSummary = Pick<EditorRevision, 'id' | 'seq' | 'label' | 'origin' | 'parentId' | 'createdAt' | 'turnId'>

export interface LiveProject {
	threadId: string
	title: string
	doc: EditorDocument
	revisions: RevisionSummary[]
	currentRevisionId: string | null
	playheadSec: number
	/**
	 * FrameFlow's own chat is running a prompt on this project. One agent at a
	 * time: an outside agent may not begin a round (or edit) until it ends.
	 */
	chatBusy?: boolean
}

/** A project in the user's FrameFlow, for list_projects. */
export interface ProjectSummary {
	id: string
	title: string
	createdAt: number
	updatedAt?: number
	mediaCount: number
	durationSec: number
	/** The editor is showing it now. */
	open: boolean
}

/** Where an export stands. */
export interface ExportStatus {
	renderId: string
	phase: 'rendering' | 'stitching' | 'done' | 'error'
	percent: number
	outputPath?: string
	error?: string
	startedAt: number
	updatedAt: number
}

export interface InspectOptions {
	times?: number[]
	fromSec?: number
	toSec?: number
	everySec?: number
	columns?: number
	tileWidth?: number
	loudness?: boolean
	/** mediaSheet: one label per time, drawn instead of the SOURCE time */
	labels?: string[]
}

export interface InspectReport {
	facts: import('../editor/exportInspect').ExportFacts
	sheet?: { data: string; mimeType: string; times: number[]; columns: number; rows: number }
	loudness?: { lufs: number | null; truePeakDb: number | null }
}

export type MediaSource = { url: string } | { path: string; name?: string }

/** What the renderer reports after it applied (or could not apply) an agent's turn. */
export type ApplyOutcome = AgentApplyOutcome

export interface TurnCommit {
	threadId: string
	turn: PromptTurn
	addMarkers?: { time: number; label: string }[]
	docSettings?: { captionsEnabled?: boolean; loudnessEnabled?: boolean; frame?: { width: number; height: number } }
	/** Assets the turn's diff refers to that the renderer does not have yet (rendered sounds). */
	addAssets?: MediaAsset[]
}

export interface RenderedFrame {
	/** Base64 image for the agent. */
	data: string
	mimeType: string
	/** A small data URL for the activity feed. */
	thumbnail?: string
	/**
	 * The motion layers in the frame and the state of each (still being checked,
	 * showing an older version, drawing nothing), plus how many of the export's
	 * motion clips are rendered. Absent when the timeline has no motion.
	 */
	motionNote?: string
}

/** What a sound measures, in words an agent can read, and a picture of it. */
export interface SoundReport {
	lengthSec: number
	/** The peak, in dBFS, and the loudness meter's reading. */
	truePeakDb: number | null
	lufs: number | null
	renderMs?: number
	/** A spectrogram as a base64 PNG: what the sound looks like, since an agent cannot hear it. */
	spectrogram?: string
}

/** A track that was just made, with a picture to check it by. */
export interface TrackSheet {
	data: string
	mimeType: string
	columns: number
	rows: number
	/** What each tile shows, in order. */
	labels: string[]
}

export interface FollowRequest {
	atSec: number
	box: { x: number; y: number; w: number; h: number }
	direction: 'forward' | 'backward' | 'both'
	fromSec: number
	toSec: number
	name: string
	shape: TrackShape
	onProgress?: (fraction: number, label: string) => void
}

/** A clip's words for Story: SOURCE seconds, with the measured quiet that placing a pick cuts into. */
export interface StoryWords {
	words: Word[]
	/** Quiet stretches in SOURCE seconds; null when they could not be measured (no sound, no words). */
	silences: { start: number; end: number }[] | null
	/** The transcript has no word timings: the words were shared out over its sentences, so edges are rough. */
	estimated?: boolean
	/** The clip's loudness every 10 ms, when asked for (placing cuts at the sound); never sent to the renderer. */
	envelope?: import('../story/place').Envelope | null
}

/** What importing or making a clip's word transcript came to. `words` is how many words it has. */
export interface TranscriptWriteResult {
	ok: boolean
	words: number
	estimated?: boolean
	error?: string
	notes?: string[]
}

export interface EditorBridge {
	/** Null when no project is open in the editor. */
	getLiveProject(): Promise<LiveProject | null>
	/** Persist the turn and apply it in the renderer; resolves once it is a revision. */
	commitTurn(commit: TurnCommit): Promise<ApplyOutcome>
	readTranscripts(project: LiveProject, assetIds: string[]): Promise<Record<string, TranscriptEntry[]>>
	renderFrame(project: LiveProject, timeSec: number): Promise<RenderedFrame>
	switchRevision(revisionId: string): Promise<{ ok: true } | { ok: false; error: string }>
	/** Start an export of the live timeline; FrameFlow shows its progress like any other. */
	startExport(project: LiveProject, options: { quality: 'original' | 'preview'; format?: DeliveryFormat; height?: number }): Promise<{ ok: true; renderId: string } | { ok: false; error: string }>
	/** The latest progress of a render, or of the project's newest one. */
	exportStatus(query: { renderId?: string; threadId: string }): ExportStatus | null
	/** What an exported file is, and contact sheets of its frames. */
	inspectExport(file: string, options: InspectOptions): Promise<InspectReport>
	/** Frames of a source file (its proxy when there is one) at SOURCE times, tiled and labelled. */
	mediaSheet(project: LiveProject, assetId: string, options: InspectOptions): Promise<{ sheet: NonNullable<InspectReport['sheet']>; durationSec: number }>
	/** Exact timeline frames (as render_frame draws them), tiled and labelled; with each frame's motion note. */
	timelineSheet(project: LiveProject, times: number[], options: { columns?: number; tileWidth?: number }): Promise<{ sheet: NonNullable<InspectReport['sheet']>; notes: (string | null)[] }>
	/**
	 * Sync recordings of one moment by their sound and return the camera group
	 * (not yet saved: the caller commits it as an edit). `existing` rebuilds a
	 * group, keeping its id, names and main sound.
	 */
	buildCameraGroup(
		project: LiveProject,
		assetIds: string[],
		options: { name?: string; existing?: import('@shared/types').MulticamGroup; onProgress?: (fraction: number, label: string) => void }
	): Promise<{ group: import('@shared/types').MulticamGroup; ranking: string[] }>
	/**
	 * Listen to a group's microphones and find who speaks when (not yet saved: the caller commits
	 * the group with these speakers as an edit). `keepFrom` carries names and hand-fixed turns over.
	 */
	diarizeGroup(
		project: LiveProject,
		group: import('@shared/types').MulticamGroup,
		options: { speakers?: number; onProgress?: (fraction: number, label: string) => void }
	): Promise<import('@shared/types').MulticamSpeakers>
	/** Whether a preparation chain is running for this media file right now (a stored "running" with none is interrupted). */
	isPreparing(project: LiveProject, assetId: string): boolean
	/**
	 * Transcribe a media file again, as the Media panel's "Transcribe again" does: the audio
	 * and transcript steps, then the pieces. Starts it and returns; it runs in the background.
	 */
	transcribeAgain(project: LiveProject, assetId: string): void
	/** Which of its two import lanes (transcript, picture) are running for this media file right now. Omitted by a bridge that cannot tell. */
	preparingLanes?(project: LiveProject, assetId: string): Array<'words' | 'picture'>
	/** Quiet stretches in a media file's sound, in source seconds. */
	findSilences(project: LiveProject, assetId: string, options: { noiseDb: number; minDurationSec: number }): Promise<{ start: number; end: number }[]>
	/** Every editor project in the user's FrameFlow. */
	listProjects(): Promise<ProjectSummary[]>
	createProject(title: string): Promise<{ id: string; title: string }>
	/** Show a project in the editor, and resolve once it has loaded. */
	openProject(threadId: string): Promise<{ ok: true } | { ok: false; error: string }>
	/** Import a link or a file into the project; resolves once the asset exists (its preprocessing runs on). */
	importMedia(project: LiveProject, source: MediaSource, onProgress?: (percent: number, phase?: string) => void): Promise<MediaAsset>

	/** Render each recipe (cached by recipe) and return its asset, ready to be placed. */
	prepareSounds(project: LiveProject, recipes: SoundRecipe[]): Promise<MediaAsset[]>
	/** Measure a recipe, or a sound already in the project. */
	inspectSound(project: LiveProject, target: { recipe: SoundRecipe } | { assetId: string }): Promise<SoundReport>
	/** Waveform and loudness of media, measured once and cached. */
	audioAnalyses(project: LiveProject, assetIds: string[]): Promise<Record<string, AudioAnalysis>>
	/** How a source sounds, as a spectrogram and numbers: for the whole asset or a range of its SOURCE seconds. Works on a video's sound too. */
	inspectAudio(project: LiveProject, req: { assetId: string; fromSec?: number; toSec?: number }): Promise<AudioInspection>
	/** Which audio providers are connected, and what an agent may spend on them. */
	audioStatus(): { connected: ProviderId[]; spend: SpendPolicy }
	/** What a request would cost in USD before it is made; null when the provider bills in credits. */
	estimateAudio(req: GenerateRequest): number | null
	/** Make a voice, effect or music with a provider, keep it as an asset in the project and hand it to the editor. */
	generateAudio(project: LiveProject, req: GenerateRequest): Promise<{ asset: MediaAsset; provenance: AudioProvenance }>

	// ----- Object tracking (tracks live beside the media, not in the document) -----
	/** Every face in a stretch of a media file (SOURCE seconds), one saved track per person. */
	findFaces(
		project: LiveProject, assetId: string,
		options: { fromSec: number; toSec: number; onProgress?: (fraction: number, label: string) => void }
	): Promise<{ tracks: ObjectTrack[]; frames: number; sheet: TrackSheet | null }>
	/** Follows a box drawn on one frame, and saves the track. */
	followObject(project: LiveProject, assetId: string, request: FollowRequest): Promise<{ track: ObjectTrack; sheet: TrackSheet | null }>
	/** The saved tracks of one media file, or of every media file in the project. */
	listTracks(project: LiveProject, assetId?: string): Promise<ObjectTrack[]>
	saveTrack(project: LiveProject, track: ObjectTrack): Promise<void>
	deleteTrack(project: LiveProject, track: Pick<ObjectTrack, 'id' | 'assetId'>): Promise<boolean>

	// ----- Story (docs/story.md): words of every take, and the stories the editor keeps -----
	/** A clip's words in SOURCE seconds and its measured quiet (measured once, cached beside the clip). */
	storyWords(project: LiveProject, assetId: string, options?: { silences?: boolean; envelope?: boolean }): Promise<StoryWords>
	/**
	 * Replace the project's stories (and clip tags, when given). Stories are renderer-owned and outside undo, like
	 * markers: the editor takes them as they are and saves them with the document.
	 */
	setStories(project: LiveProject, stories: Story[], clipTags?: Record<string, ClipTag>): Promise<void>
	/** Make a word-level transcript file the clip's transcript (whisper.cpp JSON, {words:[...]}, SRT, VTT). */
	importTranscript(project: LiveProject, assetId: string, filePath: string): Promise<TranscriptWriteResult>
	/** Transcribe a clip on this Mac with whisper.cpp (word timings, free, offline); resolves when it is done. */
	transcribeLocal(project: LiveProject, assetId: string, onProgress?: (percent: number, label: string) => void): Promise<TranscriptWriteResult>
}
