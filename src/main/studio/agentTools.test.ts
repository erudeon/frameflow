import { describe, expect, it } from 'vitest'
import { studioTools, type CommandResult } from './agentTools'

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
			expect(t.permission, t.name).toBe('read')
		}
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
