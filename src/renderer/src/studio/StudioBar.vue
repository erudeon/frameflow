<template>
	<!-- The workspaces, above every page. Edit is the app as it was; the other
	     three are the studio around it (shared/studio/modules.ts). -->
	<nav aria-label="Workspaces" data-testid="studio-bar"
		class="h-8 shrink-0 hair-b flex items-center gap-1 px-2 bg-ground select-none">
		<span class="px-1.5 text-[11px] font-semibold text-zinc-400">space Studio</span>
		<button v-for="w in WORKSPACES" :key="w.id"
			class="h-6 px-2.5 rounded-md flex items-center gap-1.5 text-xs font-semibold transition active:scale-95"
			:class="w.id === active
				? 'text-primary bg-primary/10'
				: 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-500/10'"
			:aria-pressed="w.id === active" :title="w.about" :data-workspace="w.id"
			@click="go(w.id)">
			<span class="iconify w-3.5 h-3.5" :class="w.icon"></span>
			{{ w.label }}
		</button>
	</nav>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { WORKSPACES, type WorkspaceId } from '@shared/studio/modules'
import { followRouter, pathOfModule, pathOfWorkspace, workspaceOfPath } from './nav'

const route = useRoute()
const router = useRouter()

const active = computed<WorkspaceId>(() => workspaceOfPath(route.path))

const go = (workspace: WorkspaceId) => {
	if (workspace === active.value && workspace !== 'edit') return
	void router.push(pathOfWorkspace(workspace))
}

// An agent asked for a module to be shown (show_studio_module).
let stopListening: (() => void) | undefined
onMounted(() => {
	followRouter(router)
	stopListening = (window as any).studio?.onShow?.((moduleId: string) => {
		const path = pathOfModule(moduleId)
		if (path) void router.push(path)
	})
})
onBeforeUnmount(() => stopListening?.())
</script>
