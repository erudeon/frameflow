<template>
  <AppRoot layout-style="full">
    <div
      class="h-screen w-screen overflow-hidden bg-ground text-zinc-900 dark:text-zinc-50 transition-colors duration-700 relative selection:bg-primary/20">
      <!-- Every page draws its own 40px top bar (settings, theme and background
           exports live in it), so nothing is placed over the pages from here. -->
      <!-- The workspace bar is the studio layer's (src/renderer/src/studio); the
           pages below it are untouched and fill what is left. -->
      <div class="relative z-10 h-full w-full flex flex-col">
        <StudioBar />
        <div class="flex-1 min-h-0">
          <router-view />
        </div>
      </div>

      <!-- Replaces the native confirm / alert / message boxes -->
      <ConfirmDialog />
    </div>
  </AppRoot>
</template>

<script setup lang="ts">
import { App as AppRoot } from 'pilotui/shell'
import { useAppStore } from 'pilotui/store'
import { onMounted, watch } from 'vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import StudioBar from './studio/StudioBar.vue'

const appStore = useAppStore()

watch(
  () => appStore.theme,
  (newTheme) => {
    if (newTheme === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  },
  { immediate: true }
)

onMounted(() => {
  // Initialize theme from store
  if (!appStore.theme) {
    appStore.toggleTheme('dark')
  }
})
</script>
