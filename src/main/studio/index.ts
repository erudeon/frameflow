import { app, BrowserWindow, ipcMain, shell, systemPreferences } from 'electron'
import { execFile, spawn, type ChildProcess } from 'child_process'
import http from 'http'
import type { ToolDef } from '../mcp/tools'
import { findModule } from '@shared/studio/modules'
import type { CameraAccess } from '@shared/monitor'
import { studioTools, type CommandResult } from './agentTools'

/**
 * The studio layer's half in the main process: is a module's page answering,
 * start the command that serves it, the operating system's answer on the
 * camera, and the app-side hands of the agent tools.
 *
 * Everything is looked up by module id in the one list. The window never
 * hands in a URL or a command.
 */

// A `studio` command lives on the person's PATH, which an app started from the
// Dock does not have: a login shell does. `exec "$@"` runs the arguments as
// they are, one by one; nothing is pasted into a command line.
const viaLoginShell = (argv: string[]): [string, string[]] => ['/bin/zsh', ['-lc', 'exec "$@"', 'studio-module', ...argv]]

function run(argv: string[], timeoutMs: number): Promise<CommandResult> {
	return new Promise((resolve) => {
		const [file, args] = viaLoginShell(argv)
		execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
			const e = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null
			resolve({
				code: e ? (typeof e.code === 'number' ? e.code : 1) : 0,
				stdout: String(stdout ?? ''),
				stderr: String(stderr ?? '') || (e && typeof e.code !== 'number' ? String(e.message) : ''),
				timedOut: !!e?.killed
			})
		})
	})
}

/** Any answer at all means the page's server is there. */
function answers(url: string, timeoutMs = 1500): Promise<boolean> {
	return new Promise((resolve) => {
		const req = http.get(url, { timeout: timeoutMs }, (res) => {
			res.resume()
			resolve(true)
		})
		req.on('timeout', () => { req.destroy(); resolve(false) })
		req.on('error', () => resolve(false))
	})
}

async function pageUp(moduleId: string): Promise<boolean> {
	const page = findModule(moduleId)?.page
	return page ? answers(page.url) : false
}

/** Page servers this app started, by module id: stopped when the app quits. */
const started = new Map<string, ChildProcess>()

async function startPage(moduleId: string): Promise<{ ok: boolean; error?: string }> {
	const page = findModule(moduleId)?.page
	if (!page) return { ok: false, error: 'That module has no page.' }
	if (await answers(page.url)) return { ok: true }
	if (!page.start) return { ok: false, error: `Start it yourself: ${page.startHint}` }
	if (!started.has(moduleId)) {
		const [file, args] = viaLoginShell(page.start)
		const child = spawn(file, args, { stdio: 'ignore' })
		started.set(moduleId, child)
		child.on('exit', () => { if (started.get(moduleId) === child) started.delete(moduleId) })
		child.on('error', () => { if (started.get(moduleId) === child) started.delete(moduleId) })
	}
	for (let i = 0; i < 50; i++) {
		if (await answers(page.url, 500)) return { ok: true }
		if (!started.has(moduleId)) return { ok: false, error: `"${page.startHint}" stopped before its page answered.` }
		await new Promise((r) => setTimeout(r, 400))
	}
	return { ok: false, error: `"${page.startHint}" is running but its page does not answer yet.` }
}

const cameraStatus = (): CameraAccess => {
	if (process.platform !== 'darwin' && process.platform !== 'win32') return 'unknown'
	try {
		return systemPreferences.getMediaAccessStatus('camera') as CameraAccess
	} catch {
		return 'unknown'
	}
}

/** Ask the window to show a module. False when there is no window. */
function show(moduleId: string): boolean {
	const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
	if (!win) return false
	win.webContents.send('studio-show', moduleId)
	return true
}

/** The tools the module list gives an agent, with their hands in this app. */
export const studioAgentTools = (): ToolDef[] => studioTools({ run, show, pageUp })

export function initStudio(): void {
	ipcMain.handle('studio-page-status', (_event, moduleId: string) => pageUp(String(moduleId)))
	ipcMain.handle('studio-page-start', (_event, moduleId: string) => startPage(String(moduleId)))

	/** `ask: true` shows the macOS question when it has never been answered. Asking opens no camera. */
	ipcMain.handle('studio-camera-access', async (_event, ask?: boolean): Promise<CameraAccess> => {
		const now = cameraStatus()
		if (!ask || now !== 'not-determined' || process.platform !== 'darwin') return now
		try {
			return (await systemPreferences.askForMediaAccess('camera')) ? 'granted' : 'denied'
		} catch {
			return cameraStatus()
		}
	})
	/** A refusal can only be undone in System Settings: open that page. */
	ipcMain.handle('studio-open-camera-settings', async () => {
		if (process.platform !== 'darwin') return false
		await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Camera')
		return true
	})

	app.on('before-quit', () => {
		for (const child of started.values()) child.kill()
		started.clear()
	})
}
