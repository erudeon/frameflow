import { describe, expect, it } from 'vitest'
import { studioTools, type CommandResult } from './agentTools'
import { TOOLS } from '../mcp/tools'

const ctx = {} as any
const fake = (result: Partial<CommandResult> = {}) => {
	const calls: string[][] = []
	const shown: string[] = []
	const tools = studioTools({
		run: async (argv) => { calls.push(argv); return { code: 0, stdout: '{"hits":[]}', stderr: '', ...result } },
		show: (id) => { shown.push(id); return true },
		pageUp: async (id) => id === 'library'
	})
	const call = (name: string, args: Record<string, any> = {}) => tools.find((t) => t.name === name)!.run(args, ctx)
	return { tools, calls, shown, call }
}
const textOf = (outcome: any) => outcome.content[0].text as string

describe('tools made from the module list', () => {
	it('are the two list tools and one per module that names one', () => {
		expect(fake().tools.map((t) => t.name)).toEqual(['list_studio_modules', 'show_studio_module', 'library_find', 'review_notes'])
	})
	it('never claim the project or wait in the write queue', () => {
		for (const t of fake().tools) {
			expect(t.claims, t.name).toBeUndefined()
			expect(t.writes, t.name).toBeUndefined()
		}
		// Reading and searching are `read`; moving the person's window is `edit`, as open_project is.
		expect(Object.fromEntries(fake().tools.map((t) => [t.name, t.permission]))).toEqual({
			list_studio_modules: 'read', show_studio_module: 'edit', library_find: 'read', review_notes: 'read'
		})
	})
	it('take no name the editor already uses', () => {
		const taken = new Set(TOOLS.map((t) => t.name))
		for (const t of fake().tools) expect(taken.has(t.name), t.name).toBe(false)
	})
	it('list the modules with whether a page answers', async () => {
		const listed = JSON.parse(textOf(await fake().call('list_studio_modules')))
		expect(listed.workspaces.map((w: any) => w.id)).toEqual(['shoot', 'story', 'edit', 'review'])
		const library = listed.modules.find((m: any) => m.id === 'library')
		expect(library).toMatchObject({ pageUp: true, tool: 'library_find', startWith: 'studio lib ui' })
		expect(listed.modules.find((m: any) => m.id === 'review').pageUp).toBe(false)
		expect(listed.modules.find((m: any) => m.id === 'monitor').noTool).toMatch(/studio cam/)
	})
	it('run the module\'s command with each value as one argument', async () => {
		const f = fake()
		const outcome = await f.call('library_find', { query: 'hands in the air', count: 5 })
		expect(f.calls).toEqual([['studio', 'lib', 'find', 'hands in the air', '--json', '-n', '5']])
		expect(textOf(outcome)).toBe('{"hits":[]}')
		expect(outcome.isError).toBeUndefined()
	})
	it('refuse bad arguments without running anything', async () => {
		const f = fake()
		const outcome = await f.call('library_find', { query: '--include-private' })
		expect(outcome.isError).toBe(true)
		expect(f.calls).toEqual([])
	})
	it('say so when the command fails or does not answer', async () => {
		expect(textOf(await fake({ code: 2, stderr: 'no index' }).call('review_notes', { piece: '/tmp/p' }))).toMatch(/ended with code 2[\s\S]*no index/)
		expect(textOf(await fake({ timedOut: true, code: 1 }).call('review_notes', { piece: '/tmp/p' }))).toMatch(/did not answer within 30 s/)
	})
	it('show a module, and say when its page is not up or it does not exist', async () => {
		const f = fake()
		expect(JSON.parse(textOf(await f.call('show_studio_module', { module: 'review' })))).toMatchObject({ shown: 'review', workspace: 'review', note: expect.stringMatching(/studio review piece/) })
		expect(f.shown).toEqual(['review'])
		expect((await f.call('show_studio_module', { module: 'nope' })).isError).toBe(true)
	})
})

describe('show_studio_module never takes the window from under work in the editor', () => {
	const tools = (shown: string[]) => studioTools({ run: async () => ({ code: 0, stdout: '', stderr: '' }), show: (id) => { shown.push(id); return true } })
	const show = (ctx: any, module = 'review', shown: string[] = []) =>
		tools(shown).find((t) => t.name === 'show_studio_module')!.run({ module }, ctx).then((o) => ({ o, shown }))

	it('refuses while another agent holds a round', async () => {
		const { o, shown } = await show({ sessionId: 's1', rounds: { blockedFor: () => 'Codex is working on this project.', roundFor: () => null } })
		expect(o.isError).toBe(true)
		expect((o.content[0] as any).text).toMatch(/Codex is working/)
		expect(shown).toEqual([])
	})
	it('refuses while the caller holds a round, and says to end it', async () => {
		const { o, shown } = await show({ sessionId: 's1', rounds: { blockedFor: () => null, roundFor: () => ({ id: 'r1' }) } })
		expect((o.content[0] as any).text).toMatch(/end_round/)
		expect(shown).toEqual([])
	})
	it('refuses while the chat is running a prompt', async () => {
		const { o, shown } = await show({ sessionId: 's1', bridge: { getLiveProject: async () => ({ chatBusy: true }) } })
		expect((o.content[0] as any).text).toMatch(/chat is running/)
		expect(shown).toEqual([])
	})
	it('shows it when nothing is in the way, and Edit itself is never refused', async () => {
		expect((await show({ sessionId: 's1', rounds: { blockedFor: () => null, roundFor: () => null }, bridge: { getLiveProject: async () => null } })).shown).toEqual(['review'])
		expect((await show({ sessionId: 's1', rounds: { blockedFor: () => 'held', roundFor: () => null } }, 'editor')).shown).toEqual(['editor'])
	})
})

describe('one command at a time', () => {
	it('queues calls instead of running them together', async () => {
		let running = 0
		let most = 0
		const tools = studioTools({ run: async () => { running++; most = Math.max(most, running); await new Promise((r) => setTimeout(r, 15)); running--; return { code: 0, stdout: 'ok', stderr: '' } } })
		const find = tools.find((t) => t.name === 'library_find')!
		await Promise.all([1, 2, 3, 4].map((n) => find.run({ query: `q${n}` }, {} as any)))
		expect(most).toBe(1)
	})
	it('says so when a command prints too much', async () => {
		const tools = studioTools({ run: async () => ({ code: 1, stdout: '', stderr: '', overflow: true, timedOut: false }) })
		const o = await tools.find((t) => t.name === 'library_find')!.run({ query: 'x' }, {} as any)
		expect((o.content[0] as any).text).toMatch(/more than can be taken/)
	})
})
