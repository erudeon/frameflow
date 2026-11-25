import type { ToolDef, ToolOutcome } from '../mcp/tools'
import { MODULES, WORKSPACES, buildArgv, findModule, toolInputSchema, type StudioModule } from '@shared/studio/modules'

/**
 * Agent tools made from the module list (shared/studio/modules.ts).
 *
 * A module that names an `agentTool` gets an MCP tool from that entry, with no
 * other file to touch. Two more tools come with the list itself: read it, and
 * show a module in the window.
 *
 * None of them touches the editor's project, so none claims a round or waits
 * in the write queue: they answer with no project open and while another agent
 * holds the editor.
 *
 * No Electron here (as in mcp/tools.ts): what needs the app is handed in, so
 * the tests run these with fakes.
 */

export interface CommandResult {
	code: number | null
	stdout: string
	stderr: string
	timedOut?: boolean
}

export interface StudioToolDeps {
	/** Run a command, one argument per entry, and give back what it printed. */
	run: (argv: string[], timeoutMs: number) => Promise<CommandResult>
	/** Show a module in the window. False when there is no window. */
	show?: (moduleId: string) => boolean
	/** Is a page module's page answering? */
	pageUp?: (moduleId: string) => Promise<boolean>
}

const MAX_OUTPUT = 200_000

const text = (value: string, detail: string, isError = false): ToolOutcome => ({
	content: [{ type: 'text', text: value }],
	...(isError ? { isError: true } : {}),
	feed: { detail }
})

const describe = async (m: StudioModule, deps: StudioToolDeps) => ({
	id: m.id,
	label: m.label,
	workspace: m.workspace,
	kind: m.kind,
	about: m.about,
	...(m.page ? { page: m.page.url, pageUp: deps.pageUp ? await deps.pageUp(m.id) : undefined, startWith: m.page.startHint } : {}),
	...(m.agentTool ? { tool: m.agentTool.name } : { noTool: m.noAgentTool })
})

function moduleTool(m: StudioModule, deps: StudioToolDeps): ToolDef {
	const spec = m.agentTool!
	return {
		name: spec.name,
		description: spec.description,
		permission: 'read',
		inputSchema: toolInputSchema(spec) as any,
		title: (args) => `${spec.name} ${String(Object.values(args)[0] ?? '').slice(0, 40)}`.trim(),
		async run(args) {
			let argv: string[]
			try {
				argv = buildArgv(spec, args)
			} catch (error: any) {
				return text(error?.message || 'That call cannot be run.', 'refused the arguments', true)
			}
			const result = await deps.run(argv, (spec.timeoutSec ?? 60) * 1000)
			if (result.timedOut) {
				return text(`${argv.slice(0, 3).join(' ')} did not answer within ${spec.timeoutSec ?? 60} s.`, 'timed out', true)
			}
			const out = result.stdout.length > MAX_OUTPUT ? result.stdout.slice(0, MAX_OUTPUT) + '\n[cut: the answer was longer]' : result.stdout
			if (result.code !== 0) {
				const why = (result.stderr || out || '').trim().slice(-2000)
				return text(`${argv.slice(0, 3).join(' ')} ended with code ${result.code}.\n${why}`, `failed (${result.code})`, true)
			}
			return text(out.trim() || '(no output)', `${m.label}: answered`)
		}
	}
}

export function studioTools(deps: StudioToolDeps, modules: StudioModule[] = MODULES): ToolDef[] {
	const listModules: ToolDef = {
		name: 'list_studio_modules',
		permission: 'read',
		description:
			'The studio around the editor: its workspaces (Shoot, Story, Edit, Review) and the modules in each. For every module: ' +
			'what it is, whether its page is answering, the command that starts it, and the tool that does its work for you ' +
			'(or why it has none). The work behind a module is a `studio` command you can also run yourself.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false } as any,
		async run() {
			const rows = []
			for (const m of modules) rows.push(await describe(m, deps))
			return text(JSON.stringify({ workspaces: WORKSPACES.map(({ id, label, about }) => ({ id, label, about })), modules: rows }), 'read the module list')
		}
	}

	const showModule: ToolDef = {
		name: 'show_studio_module',
		permission: 'read',
		description:
			'Put a studio module in front of the person: the window switches to its workspace and shows it (the review page, the ' +
			'library, the monitor). Use it when you want them to look at something. It changes nothing in any project.',
		inputSchema: {
			type: 'object',
			properties: { module: { type: 'string', description: 'A module id from list_studio_modules.' } },
			required: ['module'],
			additionalProperties: false
		} as any,
		title: (args) => `show ${args.module ?? ''}`,
		async run(args) {
			const m = findModule(String(args.module ?? ''), modules)
			if (!m) return text(`No module is called "${args.module}". Modules: ${modules.map((x) => x.id).join(', ')}.`, 'unknown module', true)
			if (!deps.show || !deps.show(m.id)) return text('FrameFlow has no window open to show it in.', 'no window', true)
			const up = m.page && deps.pageUp ? await deps.pageUp(m.id) : undefined
			return text(
				JSON.stringify({ shown: m.id, workspace: m.workspace, ...(up === false ? { note: `Its page is not answering. Start it with: ${m.page!.startHint}` } : {}) }),
				`showed ${m.label}`
			)
		}
	}

	return [listModules, showModule, ...modules.filter((m) => m.agentTool).map((m) => moduleTool(m, deps))]
}
