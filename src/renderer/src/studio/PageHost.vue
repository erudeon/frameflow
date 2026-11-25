<template>
	<div class="h-full min-h-0 flex flex-col" data-testid="studio-page-host" :data-up="up">
		<div class="h-9 shrink-0 hair-b flex items-center gap-2.5 px-3">
			<span class="w-1.5 h-1.5 rounded-full" :class="up ? 'bg-emerald-500' : 'bg-zinc-400'"></span>
			<span class="text-xs font-semibold">{{ module.label }}</span>
			<span class="font-mono text-[10px] text-zinc-400 truncate">{{ page.url }}</span>
			<div class="flex-1"></div>
			<button v-if="up" class="btn-icon !w-6 !h-6" aria-label="Reload the page" title="Reload" @click="frameKey++">
				<span class="iconify tabler--refresh w-3.5 h-3.5"></span>
			</button>
			<button class="btn-icon !w-6 !h-6" aria-label="Open in the browser" title="Open in the browser" @click="openOutside">
				<span class="iconify tabler--external-link w-3.5 h-3.5"></span>
			</button>
		</div>

		<!-- The page itself, as its own server sends it. It is loaded from its own
		     address, so its own checks (same origin on a save) keep working. -->
		<iframe v-if="up" :key="frameKey" :src="page.url" :title="module.label" data-testid="studio-page-frame"
			class="flex-1 min-h-0 w-full border-0 bg-white"
			sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals"></iframe>

		<div v-else class="flex-1 min-h-0 flex items-center justify-center p-8">
			<div class="max-w-md text-center">
				<span class="iconify w-8 h-8 text-zinc-400" :class="module.icon"></span>
				<h2 class="mt-3 font-heading font-semibold text-base">{{ module.label }} is not running</h2>
				<p class="mt-1.5 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{{ module.about }}</p>
				<p class="mt-4 text-[11px] text-zinc-500 dark:text-zinc-400">
					{{ page.start ? 'It is served by this command:' : 'It needs a choice only you can make, so start it yourself:' }}
				</p>
				<code class="mt-1.5 inline-block px-2.5 py-1.5 rounded-md bg-zinc-500/10 font-mono text-[11px] select-text">{{ page.startHint }}</code>
				<div class="mt-4 flex items-center justify-center gap-3">
					<button v-if="page.start" class="btn-fill" :disabled="starting" data-testid="studio-page-start" @click="start">
						{{ starting ? 'Starting…' : 'Start it' }}
					</button>
					<button class="btn-text" @click="check">Check again</button>
				</div>
				<p v-if="error" class="mt-3 text-[11px] text-red-500 dark:text-red-400">{{ error }}</p>
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { StudioModule } from '@shared/studio/modules'

/**
 * A module that is a local page (the review page, the library): framed here
 * when its server answers, and a plain "not running" with the command when it
 * does not. The main process does the asking and the starting, by module id.
 */
const props = defineProps<{ module: StudioModule }>()

const studio = (window as any).studio
const page = computed(() => props.module.page!)
const up = ref(false)
const starting = ref(false)
const error = ref('')
const frameKey = ref(0)
let timer: ReturnType<typeof setInterval> | undefined

const check = async () => {
	try {
		up.value = !!(await studio.pageStatus(props.module.id))
		if (up.value) error.value = ''
	} catch {
		up.value = false
	}
}

const start = async () => {
	if (starting.value) return
	starting.value = true
	error.value = ''
	try {
		const result = await studio.pageStart(props.module.id)
		if (!result?.ok) error.value = result?.error || 'It did not start.'
	} catch (e: any) {
		error.value = String(e?.message || 'It did not start.')
	} finally {
		starting.value = false
		await check()
	}
}

const openOutside = () => { window.open(page.value.url, '_blank') }

watch(() => props.module.id, () => { up.value = false; error.value = ''; void check() })

onMounted(() => {
	void check()
	// A page can stop or start behind the app's back: keep looking, cheaply.
	timer = setInterval(check, 4000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>
