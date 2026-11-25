<template>
	<div class="fixed inset-0 z-40 flex flex-col bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100" data-testid="story-view"
		@keydown="onKey" tabindex="0" ref="root">
		<!-- Header: the open story and what to do with it -->
		<header class="h-14 shrink-0 flex items-center gap-3 px-5 border-b border-zinc-200 dark:border-zinc-800">
			<span class="font-heading font-semibold text-lg">Story</span>
			<select v-model="openId" class="h-9 rounded-md bg-zinc-100 dark:bg-zinc-900 px-2 text-sm min-w-[200px]">
				<option v-for="s in stories" :key="s.id" :value="s.id">{{ s.name }} · {{ s.picks.length }} picks · {{ fmt(durationOf(s)) }}</option>
			</select>
			<button class="sv-btn" @click="newStory()">New story</button>
			<button v-if="open" class="sv-btn" @click="renameStory">Rename</button>
			<div class="flex-1"></div>
			<span v-if="status" class="text-sm text-zinc-500 truncate max-w-[420px]">{{ status }}</span>
			<button class="sv-btn" :disabled="!open?.picks.length" @click="playStory">{{ playingStory ? 'Stop' : 'Play story' }}</button>
			<button class="sv-btn" :disabled="!open?.picks.length" @click="importPicks">Import picks</button>
			<button class="sv-btn" :disabled="!open?.picks.length" @click="exportPicks">Export picks</button>
			<button class="sv-btn-primary" :disabled="!open?.picks.length || placing" @click="place('replace')">{{ placing ? 'Placing…' : 'Put on timeline' }}</button>
			<button class="sv-btn" :disabled="!open?.picks.length || placing" @click="place('append')" title="Add after what is on the timeline">Append</button>
			<button class="w-9 h-9 flex items-center justify-center rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label="Close Story" @click="$emit('close')">
				<span class="iconify tabler--x w-5 h-5"></span>
			</button>
		</header>

		<div class="flex-1 min-h-0 flex">
			<!-- Takes: one column per speaker, phrases you click to hear and pick -->
			<section class="flex-1 min-w-0 flex flex-col">
				<div class="shrink-0 flex items-center gap-2 px-5 py-3 border-b border-zinc-100 dark:border-zinc-900">
					<input v-model="query" placeholder="Search what was said…" class="h-10 flex-1 max-w-[420px] rounded-md bg-zinc-100 dark:bg-zinc-900 px-3 text-base" />
					<button v-for="sp in speakers" :key="sp" class="h-8 px-3 rounded-full text-sm font-semibold border transition"
						:style="{ borderColor: colour(sp) }" :class="hidden.has(sp) ? 'opacity-40' : ''" @click="toggleSpeaker(sp)">{{ sp }}</button>
					<span class="text-sm text-zinc-500 ml-2">Click a line to hear it · Shift-click to extend · A adds · J / K next / previous · Space plays</span>
				</div>
				<div class="flex-1 min-h-0 overflow-x-auto overflow-y-hidden">
					<div class="h-full flex gap-5 px-5 py-4">
						<div v-for="col in columns" :key="col.speaker" class="w-[400px] shrink-0 h-full overflow-y-auto pr-2">
							<div class="sticky top-0 z-10 bg-white/95 dark:bg-zinc-950/95 pb-2 flex items-center gap-2">
								<span class="w-3 h-3 rounded-full" :style="{ background: colour(col.speaker) }"></span>
								<span class="font-heading font-semibold text-xl">{{ col.speaker }}</span>
							</div>
							<div v-for="take in col.takes" :key="take.asset.id" class="mb-6">
								<div class="flex items-center gap-2 mb-2 text-sm text-zinc-500">
									<button class="text-lg leading-none" :title="take.tag.star ? 'Unstar this take' : 'Star this take'" @click="star(take.asset.id)">{{ take.tag.star ? '★' : '☆' }}</button>
									<input :value="take.tag.speaker || ''" placeholder="Who" class="w-24 bg-transparent border-b border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300"
										@change="tag(take.asset.id, { speaker: ($event.target as HTMLInputElement).value })" />
									<input :value="take.tag.take || ''" placeholder="Take" class="w-20 bg-transparent border-b border-zinc-200 dark:border-zinc-800"
										@change="tag(take.asset.id, { take: ($event.target as HTMLInputElement).value })" />
									<span class="truncate" :title="take.asset.name">{{ take.asset.name }}</span>
									<span class="ml-auto tabular-nums">{{ fmt(take.asset.duration || 0) }}</span>
								</div>
								<div v-if="!take.words.length" class="text-sm text-zinc-500 flex items-center gap-2">
									<span>{{ take.loading ? 'Reading words…' : take.error || 'No words yet.' }}</span>
									<button v-if="!take.loading" class="sv-btn" @click="transcribeLocal(take.asset.id)">Transcribe on this Mac</button>
									<button v-if="!take.loading" class="sv-btn" @click="importTranscript(take.asset.id)">Import transcript</button>
								</div>
								<p v-for="line in take.lines" :key="line.first" class="sv-line"
									:class="[isSelected(take.asset.id, line) ? 'sv-sel' : '', isUsed(take.asset.id, line) ? 'sv-used' : '',
										isPlaying(take.asset.id, line) ? 'sv-play' : '', matches(line.text) ? '' : 'sv-dim']"
									@click="clickLine(take.asset.id, line, $event)">
									<span class="sv-time">{{ fmt(line.start) }}</span>{{ line.text }}
								</p>
							</div>
						</div>
						<div v-if="!columns.length" class="text-zinc-500 text-lg m-auto">Import the takes in Media first; their words show here.</div>
					</div>
				</div>
			</section>

			<!-- The story: hear it, order it, trim it -->
			<aside class="w-[460px] shrink-0 border-l border-zinc-200 dark:border-zinc-800 flex flex-col">
				<div class="p-4 shrink-0">
					<video ref="player" class="w-full aspect-video rounded-lg bg-black" playsinline @timeupdate="onTime"></video>
					<div class="mt-2 flex items-center gap-2">
						<button class="sv-btn-primary" :disabled="!selection" @click="addSelection">Add to story (A)</button>
						<span v-if="selection" class="text-sm text-zinc-500 truncate">{{ selectionText }}</span>
					</div>
				</div>
				<ol class="flex-1 min-h-0 overflow-y-auto px-4 pb-6 space-y-2">
					<li v-for="(p, i) in open?.picks || []" :key="p.id" class="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3"
						:class="playingPick === p.id ? 'ring-2 ring-primary' : ''">
						<div class="flex items-center gap-2 text-sm text-zinc-500">
							<span class="tabular-nums font-semibold">{{ i + 1 }}</span>
							<span class="w-2.5 h-2.5 rounded-full" :style="{ background: colour(speakerOf(p)) }"></span>
							<span class="font-semibold text-zinc-700 dark:text-zinc-300">{{ speakerOf(p) }}</span>
							<span v-if="p.take">take {{ p.take }}</span>
							<span class="ml-auto tabular-nums">{{ fmt(p.out - p.in) }}</span>
						</div>
						<p class="mt-1 text-[17px] leading-relaxed">{{ p.text }}</p>
						<div class="mt-2 flex items-center gap-1 text-sm">
							<button class="sv-mini" @click="playPick(p)" title="Hear it">▶</button>
							<button class="sv-mini" :disabled="i === 0" @click="move(i, i - 1)" title="Earlier">▲</button>
							<button class="sv-mini" :disabled="i === (open?.picks.length || 0) - 1" @click="move(i, i + 1)" title="Later">▼</button>
							<span class="mx-1 text-zinc-400">start</span>
							<button class="sv-mini" @click="trim(p, 'in', -1)" title="One word earlier">−</button>
							<button class="sv-mini" @click="trim(p, 'in', 1)" title="One word later">+</button>
							<span class="mx-1 text-zinc-400">end</span>
							<button class="sv-mini" @click="trim(p, 'out', -1)" title="One word earlier">−</button>
							<button class="sv-mini" @click="trim(p, 'out', 1)" title="One word later">+</button>
							<button class="sv-mini ml-auto text-red-500" @click="remove(i)" title="Take it out">✕</button>
						</div>
					</li>
					<li v-if="open && !open.picks.length" class="text-zinc-500 text-base p-2">Click a line on the left, then Add. Lines already in the story are greyed.</li>
				</ol>
				<div v-if="open?.history?.length" class="shrink-0 px-4 py-2 border-t border-zinc-200 dark:border-zinc-800 text-sm">
					<button class="sv-btn" @click="undoStory">Undo last change ({{ open.history[0].by }})</button>
				</div>
			</aside>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { useEditorStore } from '../../stores/editorStore'
import { toMediaUrl } from '@shared/media-url'
import {
	movePick, pickFromWords, pickWordRange, picksFileFromStory, placeRange, storyDuration, storyFromPicksFile, wordsToLines,
	type ClipTag, type Story, type StoryPick, type Word
} from '@shared/story'

defineEmits<{ (e: 'close'): void }>()
const store = useEditorStore()
const api = (window as any).api
const root = ref<HTMLElement | null>(null)
const player = ref<HTMLVideoElement | null>(null)

// ---------------------------------------------------------------- data
type Line = ReturnType<typeof wordsToLines>[number]
interface Take { words: Word[]; silences: { start: number; end: number }[] | null; lines: Line[]; loading: boolean; error?: string }
const takes = reactive<Record<string, Take>>({})
const media = computed(() => (store.doc?.media || []).filter((a: any) => a.kind !== 'image'))
const tags = computed<Record<string, ClipTag>>(() => store.doc?.clipTags || {})
const stories = computed<Story[]>(() => store.doc?.stories || [])
const openId = ref<string | null>(null)
const open = computed(() => stories.value.find((s) => s.id === openId.value) || null)
const status = ref('')
const query = ref('')
const hidden = reactive(new Set<string>())

const loadWords = async (assetId: string) => {
	takes[assetId] = { words: [], silences: null, lines: [], loading: true }
	try {
		if (!api?.getStoryWords) throw new Error('This build has no Story backend yet.')
		const r = await api.getStoryWords(store.threadId, assetId)
		const words: Word[] = r?.words || []
		takes[assetId] = { words, silences: r?.silences || null, lines: wordsToLines(words, { maxGapSec: 0.4, maxWords: 12 }), loading: false,
			error: words.length ? undefined : 'No words yet.' }
	} catch (e: any) {
		takes[assetId] = { words: [], silences: null, lines: [], loading: false, error: e?.message || String(e) }
	}
}
onMounted(async () => {
	if (!stories.value.length) newStory('Story 1')
	openId.value = stories.value[0]?.id || null
	await Promise.all(media.value.map((a: any) => loadWords(a.id)))
	await nextTick(); root.value?.focus()
})

const speakerOf = (p: StoryPick) => p.speaker || tags.value[p.assetId]?.speaker || 'Unnamed'
const columns = computed(() => {
	const by = new Map<string, { speaker: string; takes: any[] }>()
	for (const a of media.value as any[]) {
		const tag = tags.value[a.id] || {}
		const sp = tag.speaker || 'Unnamed'
		if (hidden.has(sp)) continue
		if (!by.has(sp)) by.set(sp, { speaker: sp, takes: [] })
		by.get(sp)!.takes.push({ asset: a, tag, ...(takes[a.id] || { words: [], lines: [], loading: true }) })
	}
	for (const c of by.values()) c.takes.sort((x, y) => Number(!!y.tag.star) - Number(!!x.tag.star) || String(x.tag.take || x.asset.name).localeCompare(String(y.tag.take || y.asset.name)))
	return [...by.values()]
})
const speakers = computed(() => [...new Set((media.value as any[]).map((a) => tags.value[a.id]?.speaker || 'Unnamed'))])
const toggleSpeaker = (sp: string) => (hidden.has(sp) ? hidden.delete(sp) : hidden.add(sp))
const PALETTE = ['#E4572E', '#29335C', '#F3A712', '#669BBC', '#A8C686', '#8E7DBE', '#D16BA5', '#4C956C']
const colour = (sp: string) => PALETTE[[...sp].reduce((n, c) => n + c.charCodeAt(0), 0) % PALETTE.length]
const matches = (t: string) => !query.value.trim() || t.toLowerCase().includes(query.value.trim().toLowerCase())

// ---------------------------------------------------------------- saving
const save = (next: Story[]) => store.setStories(next)
const touch = (fn: (s: Story) => Story, by: 'person' | 'agent' = 'person') => {
	if (!open.value) return
	const cur = open.value
	const changed = fn(cur)
	const history = [{ at: Date.now(), by, picks: cur.picks }, ...(cur.history || [])].slice(0, 10)
	save(stories.value.map((s) => (s.id === cur.id ? { ...changed, history, rev: (cur.rev || 0) + 1, updatedAt: Date.now() } : s)))
}
function newStory(name?: string) {
	const s: Story = { id: `st_${Date.now().toString(36)}`, name: typeof name === 'string' ? name : `Story ${stories.value.length + 1}`, picks: [], rev: 0, createdAt: Date.now() }
	save([...stories.value, s]); openId.value = s.id
}
const renameStory = () => {
	const name = window.prompt('Name this story', open.value?.name || '')
	if (name && open.value) save(stories.value.map((s) => (s.id === open.value!.id ? { ...s, name } : s)))
}
const undoStory = () => {
	const cur = open.value
	if (!cur?.history?.length) return
	const [last, ...rest] = cur.history
	save(stories.value.map((s) => (s.id === cur.id ? { ...s, picks: last.picks, history: rest, rev: (cur.rev || 0) + 1 } : s)))
}
const tag = (assetId: string, patch: Partial<ClipTag>) => store.setClipTags({ ...tags.value, [assetId]: { ...(tags.value[assetId] || {}), ...patch } })
const star = (assetId: string) => tag(assetId, { star: !tags.value[assetId]?.star })

// ---------------------------------------------------------------- selecting and hearing
const selection = ref<{ assetId: string; a: number; b: number } | null>(null)
const lastLine = ref<{ assetId: string; line: Line } | null>(null)
const selectionText = computed(() => {
	const s = selection.value
	if (!s) return ''
	return (takes[s.assetId]?.words || []).slice(s.a, s.b + 1).map((w) => w.text).join(' ')
})
const isSelected = (assetId: string, line: Line) => !!selection.value && selection.value.assetId === assetId && line.first >= selection.value.a && line.last <= selection.value.b
const isUsed = (assetId: string, line: Line) => {
	const words = takes[assetId]?.words || []
	return (open.value?.picks || []).some((p) => {
		if (p.assetId !== assetId) return false
		const r = pickWordRange(p, words)
		return !!r && line.first >= r[0] && line.last <= r[1]
	})
}
function clickLine(assetId: string, line: Line, ev: MouseEvent) {
	const s = selection.value
	if (ev.shiftKey && s && s.assetId === assetId) selection.value = { assetId, a: Math.min(s.a, line.first), b: Math.max(s.b, line.last) }
	else selection.value = { assetId, a: line.first, b: line.last }
	lastLine.value = { assetId, line }
	const w = takes[assetId].words
	hear(assetId, w[selection.value.a].start, w[selection.value.b].end)
}
function addSelection() {
	const s = selection.value
	if (!s || !open.value) return
	const t = tags.value[s.assetId] || {}
	const p = pickFromWords(s.assetId, takes[s.assetId].words, s.a, s.b, { speaker: t.speaker, take: t.take })
	if (!p) return
	touch((st) => ({ ...st, picks: [...st.picks, p] }))
	status.value = `Added: ${p.text.slice(0, 60)}`
}

// playback: one hidden-control video plays any clip span; a story plays pick after pick
const playingKey = ref('')
const playingPick = ref<string | null>(null)
const playingStory = ref(false)
let stopAt = 0
let afterStop: (() => void) | null = null
const isPlaying = (assetId: string, line: Line) => playingKey.value === `${assetId}:${line.first}`
const srcFor = (assetId: string) => {
	const a: any = (store.doc?.media || []).find((m: any) => m.id === assetId)
	return a ? toMediaUrl(a.proxyPath || a.originalPath) : ''
}
async function hear(assetId: string, from: number, to: number, then?: () => void) {
	const v = player.value
	if (!v) return
	const src = srcFor(assetId)
	if (v.dataset.asset !== assetId) { v.src = src; v.dataset.asset = assetId; await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true })) }
	const t = takes[assetId]
	const handled = t?.words.length ? placeRange({ id: 'x', assetId, in: from, out: to, text: '' }, t.words, v.duration || undefined, t.silences || undefined) : { in: from, out: to }
	v.currentTime = handled.in; stopAt = handled.out; afterStop = then || null
	const line = t?.lines.find((l) => l.start <= from + 0.01 && l.end >= from)
	playingKey.value = line ? `${assetId}:${line.first}` : ''
	await v.play().catch(() => {})
}
function onTime() {
	const v = player.value
	if (v && stopAt && v.currentTime >= stopAt) {
		v.pause(); stopAt = 0; playingKey.value = ''
		const next = afterStop; afterStop = null; next?.()
	}
}
const playPick = (p: StoryPick) => { playingPick.value = p.id; hear(p.assetId, p.in, p.out, () => (playingPick.value = null)) }
function playStory() {
	if (playingStory.value) { playingStory.value = false; player.value?.pause(); playingPick.value = null; return }
	const picks = open.value?.picks || []
	playingStory.value = true
	const step = (i: number) => {
		if (!playingStory.value || i >= picks.length) { playingStory.value = false; playingPick.value = null; return }
		playingPick.value = picks[i].id
		hear(picks[i].assetId, picks[i].in, picks[i].out, () => step(i + 1))
	}
	step(0)
}

// ---------------------------------------------------------------- editing picks
const move = (from: number, to: number) => touch((s) => movePick(s, from, to))
const remove = (i: number) => touch((s) => ({ ...s, picks: s.picks.filter((_, k) => k !== i) }))
function trim(p: StoryPick, edge: 'in' | 'out', by: number) {
	const words = takes[p.assetId]?.words || []
	const r = pickWordRange(p, words)
	if (!r) return
	let [a, b] = r
	if (edge === 'in') a = Math.max(0, Math.min(b, a + by)); else b = Math.min(words.length - 1, Math.max(a, b + by))
	const np = pickFromWords(p.assetId, words, a, b, { speaker: p.speaker, take: p.take })
	if (np) touch((s) => ({ ...s, picks: s.picks.map((x) => (x.id === p.id ? { ...np, id: p.id, note: p.note } : x)) }))
}

// ---------------------------------------------------------------- transcripts, timeline, files
async function transcribeLocal(assetId: string) {
	takes[assetId] = { ...(takes[assetId] || { words: [], silences: null, lines: [] }), loading: true, error: undefined }
	status.value = 'Transcribing on this Mac…'
	const r = await api?.transcribeAssetLocally?.(store.threadId, assetId)
	status.value = r?.ok ? `Transcribed: ${r.words} words` : r?.error || 'Could not transcribe.'
	await loadWords(assetId)
}
async function importTranscript(assetId: string) {
	const path = await pickFile([{ name: 'Transcript', extensions: ['json', 'srt', 'vtt'] }])
	if (!path) return
	const r = await api.importAssetTranscript(store.threadId, assetId, path)
	status.value = r?.ok ? `Imported ${r.words} words` : r?.error || 'Could not import.'
	await loadWords(assetId)
}
const pickFile = async (filters: any[]) => {
	const r = await api?.showOpenDialog?.({ properties: ['openFile'], filters })
	return r && !r.canceled ? r.filePaths?.[0] : null
}
const placing = ref(false)
async function place(mode: 'replace' | 'append') {
	if (!open.value) return
	placing.value = true
	try {
		const r = await api.placeStory(store.threadId, JSON.parse(JSON.stringify(open.value)), mode)
		status.value = r?.error ? r.error : `On the timeline: ${r?.placed ?? 0} picks${r?.notes?.length ? ` · ${r.notes[0]}` : ''}`
	} catch (e: any) { status.value = e?.message || String(e) } finally { placing.value = false }
}
const assetRefs = () => (store.doc?.media || []).map((a: any) => ({ id: a.id, name: a.name, path: a.originalPath, duration: a.duration }))
async function exportPicks() {
	if (!open.value) return
	const folder = (await api.storyDefaults?.())?.folder || ''
	const path = `${folder}/${open.value.name.replace(/[^\w.-]+/g, '-')}.json`
	await api.writePicksFile(path, picksFileFromStory(open.value, assetRefs()))
	status.value = `Saved ${path}`
}
async function importPicks() {
	const path = await pickFile([{ name: 'Picks', extensions: ['json'] }])
	if (!path) return
	const file = await api.readPicksFile(path)
	const { story, unmatched } = storyFromPicksFile(file, assetRefs())
	save([...stories.value, story]); openId.value = story.id
	status.value = unmatched.length ? `${unmatched.length} picks had no matching clip: import those clips first` : `Imported ${story.picks.length} picks`
}

// ---------------------------------------------------------------- keys
const flatLines = computed(() => columns.value.flatMap((c) => c.takes.flatMap((t: any) => t.lines.map((line: Line) => ({ assetId: t.asset.id, line })))))
function onKey(e: KeyboardEvent) {
	if ((e.target as HTMLElement)?.tagName === 'INPUT') return
	if (e.key === 'a' || e.key === 'A') { e.preventDefault(); addSelection() }
	else if (e.key === ' ') { e.preventDefault(); const v = player.value; if (v) v.paused ? v.play() : v.pause() }
	else if (e.key === 'j' || e.key === 'k') {
		e.preventDefault()
		const all = flatLines.value
		const i = lastLine.value ? all.findIndex((x) => x.assetId === lastLine.value!.assetId && x.line.first === lastLine.value!.line.first) : -1
		const n = all[Math.max(0, Math.min(all.length - 1, i + (e.key === 'j' ? 1 : -1)))]
		if (n) clickLine(n.assetId, n.line, new MouseEvent('click'))
	} else if (e.key === 'Escape') { selection.value = null }
}
watch(stories, (s) => { if (!s.find((x) => x.id === openId.value)) openId.value = s[0]?.id || null })

const durationOf = (s: Story) => storyDuration(s)
const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`
</script>

<style scoped>
.sv-btn { @apply h-9 px-3 rounded-md text-sm font-semibold bg-zinc-100 dark:bg-zinc-900 hover:bg-zinc-200 dark:hover:bg-zinc-800 disabled:opacity-40; }
.sv-btn-primary { @apply h-9 px-3.5 rounded-md text-sm font-semibold bg-primary text-white hover:bg-primary-dark disabled:opacity-40; }
.sv-mini { @apply w-8 h-8 rounded-md bg-zinc-100 dark:bg-zinc-900 hover:bg-zinc-200 dark:hover:bg-zinc-800 disabled:opacity-30; }
.sv-line { @apply text-[19px] leading-[1.6] py-1 px-2 -mx-2 rounded-md cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-900; max-width: 60ch; }
.sv-time { @apply text-xs text-zinc-400 tabular-nums mr-2 select-none; }
.sv-sel { @apply bg-primary/15 hover:bg-primary/20; }
.sv-play { @apply ring-2 ring-primary/60; }
.sv-used { @apply text-zinc-400 dark:text-zinc-600; }
.sv-dim { @apply opacity-25; }
</style>
