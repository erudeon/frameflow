import { app, BrowserWindow, ipcMain, shell, systemPreferences } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import http from 'http'
import type { ToolDef } from '../mcp/tools'
import { findModule, validateModules } from '@shared/studio/modules'
import { isCaptureWindow } from '../motion/capture'
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

/** The studio's commands are on a Mac for now; anywhere else the answer is a plain "not here". */
const SUPPORTED = process.platform === 'darwin'
const MAX_BYTES = 16 * 1024 * 1024
const GRACE_MS = 2000

/** The whole family: a `studio` command is a wrapper, and its child does the work. */
/** Commands running right now for an agent: stopped with the app, not left to finish behind it. */
const running = new Set<ChildProcess>()

const stopGroup = (child: ChildProcess, signal: NodeJS.Signals) => {
	if (!child.pid) return
	try { process.kill(-child.pid, signal) } catch { try { child.kill(signal) } catch { /* already gone */ } }
}

/**
 * Run one command and give back what it printed. It always answers: when the
 * time is up the whole process group is asked to stop, then stopped, and the
 * call resolves from a timer, not from the command's good will.
 */
function run(argv: string[], timeoutMs: number): Promise<CommandResult> {
	if (!SUPPORTED) return Promise.resolve({ code: 1, stdout: '', stderr: 'The studio commands run on macOS only for now.' })
	return new Promise((resolve) => {
		const [file, args] = viaLoginShell(argv)
		const child = spawn(file, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
		running.add(child)
		const out: Buffer[] = []
		const err: Buffer[] = []
		let bytes = 0
		let done = false
		let timedOut = false
		let overflow = false
		const finish = (code: number | null, extra = '') => {
			if (done) return
			done = true
			running.delete(child)
			clearTimeout(timer)
			clearTimeout(hard)
			resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') + extra, timedOut, overflow })
		}
		let hard: ReturnType<typeof setTimeout> | undefined
		const stop = () => {
			stopGroup(child, 'SIGTERM')
			hard = setTimeout(() => { stopGroup(child, 'SIGKILL'); finish(1) }, GRACE_MS)
		}
		const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
		const take = (into: Buffer[]) => (chunk: Buffer) => {
			bytes += chunk.length
			if (bytes > MAX_BYTES) {
				if (!overflow) { overflow = true; stop() }
				return
			}
			into.push(chunk)
		}
		child.stdout?.on('data', take(out))
		child.stderr?.on('data', take(err))
		child.on('error', (error) => finish(1, String(error.message)))
		child.on('close', (code) => finish(timedOut || overflow ? 1 : code ?? 1))
	})
}

/** Any answer at all means the page's server is there. The page itself is not read. */
function answers(url: string, timeoutMs = 1500): Promise<boolean> {
	return new Promise((resolve) => {
		const req = http.get(url, { timeout: timeoutMs }, (res) => {
			res.destroy()
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

/** Page servers this app started, by module id: stopped, with their children, when the app quits. */
const started = new Map<string, { child: ChildProcess; said: string }>()

async function startPage(moduleId: string): Promise<{ ok: boolean; error?: string }> {
	const page = findModule(moduleId)?.page
	if (!page) return { ok: false, error: 'That module has no page.' }
	if (await answers(page.url)) return { ok: true }
	if (!page.start) return { ok: false, error: `Start it yourself: ${page.startHint}` }
	if (!SUPPORTED) return { ok: false, error: 'The studio commands run on macOS only for now.' }
	if (!started.has(moduleId)) {
		const [file, args] = viaLoginShell(page.start)
		const child = spawn(file, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
		const entry = { child, said: '' }
		started.set(moduleId, entry)
		// The last thing it said is why it stopped, when it stops.
		child.stderr?.on('data', (chunk: Buffer) => { entry.said = (entry.said + chunk.toString('utf8')).slice(-600) })
		const forget = () => { if (started.get(moduleId) === entry) started.delete(moduleId) }
		child.on('exit', forget)
		child.on('error', forget)
	}
	const entry = started.get(moduleId)
	for (let i = 0; i < 50; i++) {
		if (await answers(page.url, 500)) return { ok: true }
		if (!started.has(moduleId)) {
			const why = entry?.said.trim().split('\n').pop()
			return { ok: false, error: `"${page.startHint}" stopped before its page answered.${why ? ` It said: ${why}` : ''}` }
		}
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
	// Not the hidden window that draws motion layers: it would take the message and nothing would move.
	const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !isCaptureWindow(w))
	if (!win) return false
	win.webContents.send('studio-show', moduleId)
	return true
}

/** The tools the module list gives an agent, with their hands in this app. */
export const studioAgentTools = (): ToolDef[] => studioTools({ run, show, pageUp })

export function initStudio(): void {
	// The list is checked where it is written (its tests); a broken one must still be loud here.
	for (const problem of validateModules()) console.error('[studio] the module list is wrong:', problem)

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
		for (const { child } of started.values()) stopGroup(child, 'SIGTERM')
		started.clear()
		for (const child of running) stopGroup(child, 'SIGTERM')
		running.clear()
	})
}
