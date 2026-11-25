import { contextBridge, ipcRenderer } from 'electron'

/**
 * The studio layer's own door into the main process, kept apart from the
 * editor's `window.api` so the two never meet in one file. See
 * src/shared/studio/modules.ts for what a module is.
 */
const studio = {
	/** Is this module's page answering? */
	pageStatus: (moduleId: string): Promise<boolean> => ipcRenderer.invoke('studio-page-status', moduleId),
	/** Start the command that serves it, where the app can: `{ ok, error? }`. */
	pageStart: (moduleId: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('studio-page-start', moduleId),
	/** 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'. `ask` shows the macOS question once. */
	cameraAccess: (ask = false): Promise<string> => ipcRenderer.invoke('studio-camera-access', ask),
	openCameraSettings: (): Promise<boolean> => ipcRenderer.invoke('studio-open-camera-settings'),
	/** An agent asked for a module to be shown. Returns the unsubscribe. */
	onShow: (callback: (moduleId: string) => void) => {
		const listener = (_event: unknown, moduleId: string) => callback(moduleId)
		ipcRenderer.on('studio-show', listener)
		return () => ipcRenderer.removeListener('studio-show', listener)
	}
}

export type StudioApi = typeof studio

if (process.contextIsolated) {
	try {
		contextBridge.exposeInMainWorld('studio', studio)
	} catch (error) {
		console.error('[Preload] Failed to expose the studio API:', error)
	}
} else {
	// @ts-ignore
	window.studio = studio
}
