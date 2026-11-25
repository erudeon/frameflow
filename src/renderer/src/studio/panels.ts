import type { Component } from 'vue'
import MonitorPanel from './panels/MonitorPanel.vue'

/** The panels the app draws itself, by the name a module gives in shared/studio/modules.ts (`panel`). */
export const PANELS: Record<string, Component> = {
	monitor: MonitorPanel
}
