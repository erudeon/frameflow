/**
 * The studio's modules: ONE list.
 *
 * FrameFlow's editor is one workspace of four. Everything else the studio does
 * (filming, the script and the story, the library, review) is a module in a
 * workspace, and a module is one entry in this file. From that entry come:
 *
 *   - its place in the app (which workspace, its row in the workspace's list);
 *   - what the window shows for it (a local page framed in the app, a panel
 *     drawn by the app, or a door into the editor);
 *   - its tool for an agent, when it has one (main/studio/agentTools.ts builds
 *     the MCP tool from `agentTool`). A module with no tool says why.
 *
 * Pure data and pure functions: the main process, the window and the tests all
 * read the same list. The work itself is never here. A module is a view over a
 * `studio` command or a page that command serves, so an agent can do the same
 * work with no window at all.
 */

export type WorkspaceId = 'shoot' | 'story' | 'edit' | 'review'

export interface Workspace {
	id: WorkspaceId
	label: string
	/** An icon class (tabler), as the rest of the app writes them. */
	icon: string
	about: string
}

export const WORKSPACES: Workspace[] = [
	{ id: 'shoot', label: 'Shoot', icon: 'tabler--video', about: 'Cameras, the take and what was filmed.' },
	{ id: 'story', label: 'Story', icon: 'tabler--text-caption', about: 'The script, the words of every take, and the footage library.' },
	{ id: 'edit', label: 'Edit', icon: 'tabler--cut', about: 'The editor: projects, the timeline, the assistant.' },
	{ id: 'review', label: 'Review', icon: 'tabler--eye-check', about: 'Versions side by side, notes at a timecode, the pick.' }
]

/** `page`: a local page framed in the app. `panel`: drawn by the app. `editor`: a door into the editor. */
export type ModuleKind = 'page' | 'panel' | 'editor'

export interface PageSpec {
	/** Loopback only (127.0.0.1 or localhost): a module never frames the open web. */
	url: string
	/** The command that serves the page, when it needs no choice from a person. The app can start it. */
	start?: string[]
	/** What to type when the app cannot start it by itself (it needs a folder, a piece). */
	startHint: string
}

export interface AgentParam {
	type: 'string' | 'integer'
	description: string
	required?: boolean
	/** Used when the agent leaves it out. */
	default?: string | number
}

export interface AgentToolSpec {
	/** The MCP tool's name, snake_case. */
	name: string
	description: string
	/**
	 * The command, one argument per entry. An entry that is exactly `{name}` is
	 * replaced by that parameter's value, whole: a value can never become two
	 * arguments or a flag of its own making.
	 */
	argv: string[]
	params: Record<string, AgentParam>
	timeoutSec?: number
}

export interface StudioModule {
	id: string
	label: string
	icon: string
	workspace: WorkspaceId
	kind: ModuleKind
	about: string
	page?: PageSpec
	/** For `panel`: which panel of the app draws it (renderer/studio/panels.ts). */
	panel?: string
	/** For `editor`: open the Story view once a project is on screen. */
	opensStory?: boolean
	/** Its tool for an agent. Exactly one of `agentTool` and `noAgentTool` is set. */
	agentTool?: AgentToolSpec
	/** Why this module has no tool of its own. */
	noAgentTool?: string
}

export const MODULES: StudioModule[] = [
	{
		id: 'monitor', label: 'Monitor', icon: 'tabler--device-computer-camera', workspace: 'shoot', kind: 'panel', panel: 'monitor',
		about: 'A live camera picture. One camera for now; every camera at once comes with the full Monitor.',
		noAgentTool: 'Cameras are driven by `studio cam` (status, preflight, take), which answers an agent with no window. A tool here comes when cam has a service to ask.'
	},
	{
		id: 'story', label: 'Story', icon: 'tabler--text-caption', workspace: 'story', kind: 'editor', opensStory: true,
		about: 'Pick spoken moments from every take by their words. Opens in a project.',
		noAgentTool: 'The story tools are already in the editor\'s own list (get_stories, get_words, set_story, add_picks, edit_pick, place_story).'
	},
	{
		id: 'library', label: 'Library', icon: 'tabler--photo-search', workspace: 'story', kind: 'page',
		about: 'Search all footage by picture, by words said and by text on screen.',
		page: { url: 'http://127.0.0.1:8795/', start: ['studio', 'lib', 'ui'], startHint: 'studio lib ui' },
		agentTool: {
			name: 'library_find',
			description:
				'Search the studio\'s footage library (every indexed clip, not only this project\'s media) by what is shown, what is said ' +
				'or text on screen. Returns ranked moments: the clip, in and out in SOURCE seconds, a still, and where the file is. ' +
				'The same search as the Library module and as `studio lib find --json`.',
			argv: ['studio', 'lib', 'find', '{query}', '--json', '-n', '{count}'],
			params: {
				query: { type: 'string', description: 'What to look for, in plain words. Put an exact phrase in double quotes.', required: true },
				count: { type: 'integer', description: 'How many moments to return (1 to 50).', default: 10 }
			},
			timeoutSec: 90
		}
	},
	{
		id: 'editor', label: 'Editor', icon: 'tabler--cut', workspace: 'edit', kind: 'editor',
		about: 'Projects and the timeline.',
		noAgentTool: 'The editor is what the other tools in this list are for.'
	},
	{
		id: 'review', label: 'Piece review', icon: 'tabler--eye-check', workspace: 'review', kind: 'page',
		about: 'One piece: its versions side by side, the gate\'s report, notes at a timecode, the pick.',
		page: { url: 'http://127.0.0.1:8791/', startHint: 'studio review piece <the piece\'s folder>' },
		agentTool: {
			name: 'review_notes',
			description:
				'The notes and the pick a person left on a piece\'s review page: each note with its version and timecode, in their words. ' +
				'Read them before changing a cut that was reviewed. The same as `studio review notes <piece> --json`.',
			argv: ['studio', 'review', 'notes', '{piece}', '--json'],
			params: {
				piece: { type: 'string', description: 'The piece\'s folder (absolute path), the one that holds its storyboard.json.', required: true }
			},
			timeoutSec: 30
		}
	},
	{
		id: 'review-folder', label: 'Review folder', icon: 'tabler--folders', workspace: 'review', kind: 'page',
		about: 'A folder of review pages served as one (the morning page of a studio night).',
		page: { url: 'http://127.0.0.1:8790/', startHint: 'studio review serve <folder>' },
		noAgentTool: 'A folder of pages has nothing to ask: its answers are files in that folder.'
	}
]

export const modulesOf = (workspace: WorkspaceId, modules: StudioModule[] = MODULES): StudioModule[] =>
	modules.filter((m) => m.workspace === workspace)

export const findModule = (id: string, modules: StudioModule[] = MODULES): StudioModule | undefined =>
	modules.find((m) => m.id === id)

export const isWorkspaceId = (value: unknown): value is WorkspaceId =>
	typeof value === 'string' && WORKSPACES.some((w) => w.id === value)

/** Only this computer: http, and the host is 127.0.0.1 or localhost. */
export function isLoopbackUrl(url: string): boolean {
	try {
		const u = new URL(url)
		return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')
	} catch {
		return false
	}
}

const PLACEHOLDER = /^\{([a-z][a-zA-Z0-9]*)\}$/

/** What is wrong with the list, one sentence each. Empty when it is sound. The tests pin it to empty. */
export function validateModules(modules: StudioModule[] = MODULES): string[] {
	const problems: string[] = []
	const ids = new Set<string>()
	const toolNames = new Set<string>()
	for (const m of modules) {
		if (ids.has(m.id)) problems.push(`Two modules are called "${m.id}".`)
		ids.add(m.id)
		if (!isWorkspaceId(m.workspace)) problems.push(`${m.id}: "${m.workspace}" is not a workspace.`)
		if (m.kind === 'page') {
			if (!m.page) problems.push(`${m.id}: a page module needs its page.`)
			else if (!isLoopbackUrl(m.page.url)) problems.push(`${m.id}: ${m.page.url} is not a page on this computer.`)
		}
		if (m.kind === 'panel' && !m.panel) problems.push(`${m.id}: a panel module names its panel.`)
		if (!!m.agentTool === !!m.noAgentTool) problems.push(`${m.id}: give its agent tool, or say why it has none (one of the two).`)
		const tool = m.agentTool
		if (!tool) continue
		if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) problems.push(`${m.id}: the tool name "${tool.name}" is not snake_case.`)
		if (toolNames.has(tool.name)) problems.push(`Two tools are called "${tool.name}".`)
		toolNames.add(tool.name)
		if (!tool.argv.length || PLACEHOLDER.test(tool.argv[0])) problems.push(`${m.id}: the command itself is fixed, never a parameter.`)
		for (const part of tool.argv) {
			const name = PLACEHOLDER.exec(part)?.[1]
			if (name && !tool.params[name]) problems.push(`${m.id}: {${name}} has no parameter.`)
			if (!name && /[{}]/.test(part)) problems.push(`${m.id}: "${part}" mixes text and a parameter; a parameter is a whole argument.`)
		}
		for (const name of Object.keys(tool.params)) {
			if (!tool.argv.includes(`{${name}}`)) problems.push(`${m.id}: the parameter ${name} is never used.`)
		}
	}
	return problems
}

/**
 * The command for one call: every `{name}` replaced by its value. Throws a
 * sentence an agent can act on when a value is missing or the wrong kind.
 * A value that starts with "-" is refused: it would be read as a flag.
 */
export function buildArgv(tool: AgentToolSpec, args: Record<string, unknown>): string[] {
	return tool.argv.map((part) => {
		const name = PLACEHOLDER.exec(part)?.[1]
		if (!name) return part
		const spec = tool.params[name]
		const raw = args[name] ?? spec.default
		if (raw === undefined || raw === null || raw === '') {
			throw new Error(`${tool.name} needs "${name}": ${spec.description}`)
		}
		if (spec.type === 'integer') {
			const n = typeof raw === 'number' ? raw : Number(raw)
			if (!Number.isInteger(n) || n < 0 || n > 100000) throw new Error(`${tool.name}: "${name}" must be a whole number.`)
			return String(n)
		}
		if (typeof raw !== 'string') throw new Error(`${tool.name}: "${name}" must be text.`)
		const value = raw.trim()
		if (!value) throw new Error(`${tool.name} needs "${name}": ${spec.description}`)
		if (value.startsWith('-')) throw new Error(`${tool.name}: "${name}" may not start with "-".`)
		if (value.length > 2000) throw new Error(`${tool.name}: "${name}" is too long.`)
		return value
	})
}

/** The JSON Schema an MCP client is shown for a module's tool. */
export function toolInputSchema(tool: AgentToolSpec): Record<string, unknown> {
	const properties: Record<string, unknown> = {}
	for (const [name, spec] of Object.entries(tool.params)) {
		properties[name] = { type: spec.type, description: spec.description, ...(spec.default !== undefined ? { default: spec.default } : {}) }
	}
	return {
		type: 'object',
		properties,
		required: Object.entries(tool.params).filter(([, spec]) => spec.required).map(([name]) => name),
		additionalProperties: false
	}
}
