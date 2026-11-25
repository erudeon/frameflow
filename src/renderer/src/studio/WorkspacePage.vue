<template>
	<!-- One studio workspace: its modules on the left, the chosen one filling the rest. -->
	<div v-if="valid" class="h-full w-full flex min-h-0 bg-ground" data-testid="studio-workspace" :data-workspace="workspace.id">
		<aside class="w-52 shrink-0 hair-r flex flex-col min-h-0">
			<div class="px-3 pt-3 pb-2">
				<h1 class="font-heading font-semibold text-[15px] tracking-tight">{{ workspace.label }}</h1>
				<p class="mt-0.5 text-[10px] leading-snug text-zinc-400">{{ workspace.about }}</p>
			</div>
			<nav aria-label="Modules" class="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-1.5 pb-3">
				<button v-for="m in modules" :key="m.id"
					class="w-full flex items-start gap-2 px-2 py-2 rounded-md text-left transition"
					:class="m.id === current?.id
						? 'bg-primary/10 text-primary'
						: 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-500/10'"
					:aria-pressed="m.id === current?.id" :data-module="m.id"
					@click="pick(m.id)">
					<span class="iconify w-4 h-4 mt-0.5 shrink-0" :class="m.icon"></span>
					<span class="min-w-0">
						<span class="block text-xs font-semibold truncate">{{ m.label }}</span>
						<span class="block text-[10px] leading-snug text-zinc-400 line-clamp-2">{{ m.about }}</span>
					</span>
				</button>
			</nav>
		</aside>

		<main class="flex-1 min-w-0 min-h-0">
			<PageHost v-if="current?.kind === 'page'" :key="current.id" :module="current" />
			<div v-else-if="current?.kind === 'panel' && panel" class="h-full min-h-0 overflow-y-auto custom-scrollbar">
				<div class="max-w-3xl mx-auto h-full flex flex-col">
					<component :is="panel" :key="current.id" class="flex-1 min-h-0" />
				</div>
			</div>
			<EditorDoor v-else-if="current?.kind === 'editor'" :key="current.id" :module="current" />
			<div v-else class="h-full flex items-center justify-center text-xs text-zinc-400">Nothing here yet.</div>
		</main>
	</div>
</template>

<script setup lang="ts">
import { computed, watchEffect } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { WORKSPACES, isWorkspaceId, modulesOf } from '@shared/studio/modules'
import { STUDIO_PREFIX, lastEditPath } from './nav'
import { PANELS } from './panels'
import PageHost from './PageHost.vue'
import EditorDoor from './EditorDoor.vue'

/**
 * The page behind `/studio/<workspace>/<module>`. It draws nothing of its own
 * beyond the list: what a module is and where it lives comes from the one
 * list in shared/studio/modules.ts.
 */
const route = useRoute()
const router = useRouter()

/** Edit is the app itself, and an unknown name is nobody's: neither is drawn here, not even for one frame (a panel may open a camera). */
const valid = computed(() => isWorkspaceId(route.params.workspace) && route.params.workspace !== 'edit')
const workspace = computed(() => {
	const id = route.params.workspace
	return WORKSPACES.find((w) => w.id === id) ?? WORKSPACES[0]
})
const modules = computed(() => modulesOf(workspace.value.id))
const current = computed(() => modules.value.find((m) => m.id === route.params.module) ?? modules.value[0])
const panel = computed(() => (current.value?.panel ? PANELS[current.value.panel] : undefined))

watchEffect(() => {
	if (!valid.value) void router.replace(lastEditPath.value)
})

const pick = (moduleId: string) => {
	if (moduleId !== current.value?.id) void router.push(`${STUDIO_PREFIX}${workspace.value.id}/${moduleId}`)
}
</script>
