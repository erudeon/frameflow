<template>
	<div class="h-full min-h-0 overflow-y-auto custom-scrollbar p-8" data-testid="studio-editor-door">
		<div class="max-w-xl mx-auto">
			<h2 class="font-heading font-semibold text-base">{{ module.label }}</h2>
			<p class="mt-1.5 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
				{{ module.about }}
				{{ module.opensStory ? 'Choose the project whose takes you want to read.' : '' }}
			</p>

			<p v-if="!loaded" class="mt-6 text-xs text-zinc-400">Reading your projects…</p>
			<p v-else-if="!projects.length" class="mt-6 text-xs text-zinc-500 dark:text-zinc-400">
				There is no editor project yet. Make one in Edit, bring the takes in, and come back.
			</p>
			<div v-else class="mt-5">
				<button v-for="p in projects" :key="p.id"
					class="w-full flex items-center gap-3 h-11 px-2 rounded hair-t first:border-t-0 text-left transition hover:bg-primary/[0.06]"
					@click="open(p.id)">
					<span class="iconify tabler--movie w-4 h-4 text-zinc-400 shrink-0"></span>
					<span class="flex-1 min-w-0 text-xs font-semibold truncate">{{ p.title || 'Untitled Project' }}</span>
					<span class="text-[10px] font-mono text-zinc-400 shrink-0">{{ p.media }} clips</span>
					<span class="iconify tabler--chevron-right w-3.5 h-3.5 text-zinc-400 shrink-0"></span>
				</button>
			</div>
			<p class="mt-6 text-[10px] leading-relaxed text-zinc-400">
				A project opens in the editor, which asks for its own set-up the first time.
			</p>
		</div>
	</div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { StudioModule } from '@shared/studio/modules'
import { useEditorStore } from '../stores/editorStore'

/**
 * A module that lives inside the editor (Story): choose a project, and the
 * editor opens on it with that view in front.
 */
const props = defineProps<{ module: StudioModule }>()

const router = useRouter()
const editor = useEditorStore()
const loaded = ref(false)
const projects = ref<{ id: string; title: string; media: number }[]>([])

onMounted(async () => {
	try {
		const all: any[] = await (window as any).api.getAllThreads()
		projects.value = all
			.filter((t) => t?.type === 'editor')
			.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
			.map((t) => ({ id: t.id, title: t.title, media: t.editor?.media?.length ?? 0 }))
	} catch {
		projects.value = []
	}
	loaded.value = true
})

const open = (id: string) => {
	// The Story view is a view of the editor page: ask for it, then go there.
	if (props.module.opensStory) editor.storyOpen = true
	void router.push(`/editor/${id}`)
}
</script>
