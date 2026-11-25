<template>
	<div class="flex flex-col min-h-0 overflow-hidden" data-testid="monitor-panel">
		<div class="px-3 pt-3 pb-2 flex items-center shrink-0">
			<span class="lbl">Monitor <span class="font-mono normal-case tracking-normal font-normal text-zinc-400 ml-1">{{ cameras.length }}</span></span>
			<div class="flex-1"></div>
			<button v-if="activeId" class="btn-text !h-5 !px-0 !text-[10px]" data-testid="monitor-stop" @click="stop">Stop</button>
		</div>

		<!-- The picture. Black until a camera answers, like a monitor with no signal. -->
		<div class="px-3 shrink-0">
			<div class="relative w-full aspect-video rounded-md overflow-hidden bg-black">
				<video ref="videoEl" class="w-full h-full object-contain" autoplay muted playsinline
					data-testid="monitor-video" :data-live="live" :data-frames="frames"></video>
				<div v-if="!live"
					class="absolute inset-0 flex items-center justify-center px-4 text-center text-[10px] leading-snug text-zinc-400">
					{{ idleText }}
				</div>
				<span v-else
					class="absolute top-1.5 left-1.5 flex items-center gap-1 px-1.5 h-4 rounded bg-black/60 text-[9px] font-bold uppercase tracking-widest text-white">
					<span class="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse"></span>Live
				</span>
			</div>
			<p class="mt-1.5 h-4 text-[10px] font-mono text-zinc-400 truncate" data-testid="monitor-stats">{{ statsText }}</p>
		</div>

		<!-- macOS has not said yes: say what to do, never a dead black box. -->
		<div v-if="!allowed" class="px-3 pt-1 pb-2 shrink-0" data-testid="monitor-blocked">
			<p class="text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">{{ blockedText }}</p>
			<div class="mt-1.5 flex items-center gap-3">
				<button v-if="access === 'not-determined'" class="btn-text btn-text-primary !h-5 !px-0 !text-[10px]" @click="refresh(true)">Allow the camera</button>
				<button v-else class="btn-text btn-text-primary !h-5 !px-0 !text-[10px]" @click="openSettings">Open Camera settings</button>
				<button class="btn-text !h-5 !px-0 !text-[10px]" @click="refresh(false)">Check again</button>
			</div>
		</div>

		<p v-if="error" class="px-3 pb-2 shrink-0 text-[10px] leading-snug text-red-500 dark:text-red-400" data-testid="monitor-error">{{ error }}</p>

		<div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-1.5 pb-3">
			<div class="px-1.5 pt-2 pb-1.5">
				<span class="text-[9px] font-bold uppercase tracking-widest text-zinc-400">Cameras</span>
			</div>
			<p v-if="!cameras.length" class="px-1.5 text-[10px] leading-snug text-zinc-400">
				No camera found. Plug the studio camera in on its cable and switch it to Webcam.
			</p>
			<button v-for="camera in cameras" :key="camera.deviceId"
				class="group w-full flex items-center gap-2 h-[38px] px-1.5 rounded hair-t first:border-t-0 text-left transition hover:bg-primary/[0.06]"
				:class="{ 'bg-primary/[0.10]': camera.deviceId === activeId }"
				:disabled="!allowed" :aria-pressed="camera.deviceId === activeId"
				:data-camera-kind="cameraKind(camera.label)"
				@click="open(camera, true)">
				<span class="iconify w-3.5 h-3.5 shrink-0"
					:class="[ICON[cameraKind(camera.label)], camera.deviceId === activeId ? 'text-primary' : 'text-zinc-400']"></span>
				<span class="flex-1 min-w-0">
					<span class="block text-xs font-semibold truncate">{{ cameraName(camera.label) || 'Camera (not allowed yet)' }}</span>
					<span class="block text-[9px] text-zinc-400 truncate">{{ KIND_LABEL[cameraKind(camera.label)] }}</span>
				</span>
				<span v-if="camera.deviceId === activeId" class="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0"></span>
			</button>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
	KIND_LABEL, accessAllows, cameraKind, cameraName, constraintsFor, describeFeed, pickAutoCamera, sortCameras,
	type CameraAccess, type CameraInfo, type CameraKind
} from '@shared/monitor'

/**
 * Monitor: a live camera picture in the left panel.
 *
 * It opens the studio camera on its cable, or this computer's own camera, by
 * itself; any other camera waits to be picked (shared/monitor.ts says why).
 * The camera is held only while this panel is on screen: leaving the Monitor
 * module (another module, another workspace) lets the camera go.
 *
 * Nothing here touches the project: no clip is made and nothing is recorded.
 */

const ICON: Record<CameraKind, string> = {
	studio: 'tabler--video',
	builtin: 'tabler--device-laptop',
	other: 'tabler--device-mobile'
}

const api = (window as any).studio

const videoEl = ref<HTMLVideoElement | null>(null)
const access = ref<CameraAccess>('unknown')
const cameras = ref<CameraInfo[]>([])
const activeId = ref<string | null>(null)
const error = ref('')
const live = ref(false)
const frames = ref(0)
const fps = ref(0)
const size = ref({ width: 0, height: 0 })

let stream: MediaStream | null = null
/** A camera the person chose stays until they choose again; one the panel chose may be replaced. */
let pickedByPerson = false
/** After "Stop" nothing reopens by itself: the person picks the next camera. */
let stopped = false
/** Each open gets a number, so an answer that arrives late (another camera was picked, the tab closed) is dropped. */
let openSeq = 0
let frameCallback = 0
let windowStart = 0
let windowFrames = 0

const allowed = computed(() => accessAllows(access.value))

const blockedText = computed(() => {
	if (access.value === 'not-determined') return 'macOS has not been asked yet whether FrameFlow may use the camera.'
	if (access.value === 'restricted') return 'This Mac does not let apps use the camera (a restriction set on the computer).'
	return 'macOS has not allowed FrameFlow to use the camera. Switch FrameFlow on under Privacy & Security, Camera, then check again.'
})

const idleText = computed(() => {
	if (!allowed.value) return 'No picture: the camera is not allowed yet'
	if (activeId.value) return 'Waiting for the picture'
	if (!cameras.value.length) return 'No camera'
	return 'Pick a camera below'
})

const statsText = computed(() => {
	// The size and rate only: the list below already says which camera it is.
	if (!activeId.value) return ''
	return describeFeed(size.value.width, size.value.height, fps.value)
})

const listCameras = async () => {
	const devices = await navigator.mediaDevices.enumerateDevices()
	cameras.value = sortCameras(devices
		.filter((d) => d.kind === 'videoinput')
		.map((d) => ({ deviceId: d.deviceId, label: d.label })))
}

/** Let the camera go: its light goes out. */
const release = () => {
	openSeq++
	const el = videoEl.value
	if (el && frameCallback) el.cancelVideoFrameCallback(frameCallback)
	frameCallback = 0
	stream?.getTracks().forEach((track) => track.stop())
	stream = null
	if (el) el.srcObject = null
	activeId.value = null
	live.value = false
	frames.value = 0
	fps.value = 0
	size.value = { width: 0, height: 0 }
}

const stop = () => {
	stopped = true
	release()
}

/** Count real frames: the size and the rate shown are measured, not what was asked for. */
const countFrames = (el: HTMLVideoElement, seq: number) => {
	windowStart = 0
	windowFrames = 0
	const onFrame: VideoFrameRequestCallback = (now, meta) => {
		if (seq !== openSeq) return
		frames.value++
		live.value = true
		if (meta.width !== size.value.width || meta.height !== size.value.height) {
			size.value = { width: meta.width, height: meta.height }
		}
		if (!windowStart) windowStart = now
		windowFrames++
		if (now - windowStart >= 1000) {
			fps.value = (windowFrames * 1000) / (now - windowStart)
			windowStart = now
			windowFrames = 0
		}
		frameCallback = el.requestVideoFrameCallback(onFrame)
	}
	frameCallback = el.requestVideoFrameCallback(onFrame)
}

const readable = (e: any): string => {
	const name = String(e?.name || '')
	if (name === 'NotAllowedError') return 'The camera was refused. Check Camera under Privacy & Security.'
	if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'That camera is no longer there.'
	if (name === 'NotReadableError') return 'The camera did not start. It may be switched off or held by another app.'
	return String(e?.message || 'The camera did not start.')
}

const open = async (camera: CameraInfo, byPerson = false) => {
	if (!allowed.value || !camera.deviceId) return
	release()
	const seq = openSeq
	pickedByPerson = byPerson
	stopped = false
	activeId.value = camera.deviceId
	error.value = ''
	try {
		const next = await navigator.mediaDevices.getUserMedia(constraintsFor(camera))
		if (seq !== openSeq || !videoEl.value) {
			next.getTracks().forEach((track) => track.stop())
			return
		}
		stream = next
		// Unplugged, or taken away by the OS: say so and look for another.
		next.getVideoTracks()[0]?.addEventListener('ended', () => {
			if (seq !== openSeq) return
			release()
			pickedByPerson = false
			void refresh(false)
		})
		videoEl.value.srcObject = next
		countFrames(videoEl.value, seq)
		await videoEl.value.play().catch(() => { /* autoplay muted: nothing to do if the element went away */ })
	} catch (e) {
		if (seq !== openSeq) return
		release()
		error.value = readable(e)
	}
}

/**
 * Read the OS's answer and the camera list, then open what may be opened by
 * itself. Runs when the panel appears and whenever a camera is plugged in or out.
 */
const refresh = async (ask: boolean) => {
	try {
		access.value = await api.cameraAccess(ask)
	} catch {
		access.value = 'unknown'
	}
	await listCameras()
	if (!allowed.value) {
		release()
		return
	}
	const current = cameras.value.find((c) => c.deviceId === activeId.value)
	// Theirs to keep; and the studio camera is never swapped for a lesser one.
	if (current && (pickedByPerson || cameraKind(current.label) === 'studio')) return
	if (stopped) return
	const auto = pickAutoCamera(cameras.value)
	if (auto && auto.deviceId !== activeId.value) await open(auto)
	else if (!auto && !current) release()
}

const openSettings = () => { void api.openCameraSettings() }

const onDeviceChange = () => { void refresh(false) }

onMounted(() => {
	navigator.mediaDevices.addEventListener('devicechange', onDeviceChange)
	// Opening the Monitor tab is the request: ask macOS once if it was never asked.
	void refresh(true)
})

onBeforeUnmount(() => {
	navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange)
	release()
})
</script>
