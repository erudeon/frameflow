import { ipcMain, shell, systemPreferences } from 'electron'
import type { CameraAccess } from '@shared/monitor'

/**
 * Monitor's one need from the main process: the operating system's answer on
 * the camera. The picture itself never comes through here; the panel opens the
 * camera in the window (`getUserMedia`).
 *
 * macOS asks the person once per app. Asking is separate from opening, so the
 * panel can ask without switching any camera on.
 */

const status = (): CameraAccess => {
	if (process.platform !== 'darwin' && process.platform !== 'win32') return 'unknown'
	try {
		return systemPreferences.getMediaAccessStatus('camera') as CameraAccess
	} catch {
		return 'unknown'
	}
}

export function initMonitorIpc(): void {
	/** `ask: true` shows the macOS question when it has never been answered. */
	ipcMain.handle('monitor-camera-access', async (_event, ask?: boolean): Promise<CameraAccess> => {
		const now = status()
		if (!ask || now !== 'not-determined' || process.platform !== 'darwin') return now
		try {
			return (await systemPreferences.askForMediaAccess('camera')) ? 'granted' : 'denied'
		} catch {
			return status()
		}
	})

	/** A refusal can only be undone in System Settings: open that page. */
	ipcMain.handle('monitor-open-camera-settings', async () => {
		if (process.platform !== 'darwin') return false
		await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Camera')
		return true
	})
}
