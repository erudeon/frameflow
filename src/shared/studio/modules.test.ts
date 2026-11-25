import { describe, expect, it } from 'vitest'
import { MODULES, WORKSPACES, buildArgv, findModule, isLoopbackUrl, modulesOf, toolInputSchema, validateModules, type StudioModule } from './modules'

describe('the module list', () => {
	it('is sound as written', () => {
		expect(validateModules()).toEqual([])
	})
	it('gives every workspace at least one module', () => {
		for (const w of WORKSPACES) expect(modulesOf(w.id).length, w.id).toBeGreaterThan(0)
	})
	it('holds the two pages the frame starts with', () => {
		expect(findModule('review')?.page?.url).toBe('http://127.0.0.1:8791/')
		expect(findModule('library')?.page?.url).toBe('http://127.0.0.1:8795/')
	})
})

describe('validateModules', () => {
	const base: StudioModule = { id: 'x', label: 'X', icon: 'i', workspace: 'review', kind: 'page', about: '', page: { url: 'http://127.0.0.1:1/', startHint: 'x' }, noAgentTool: 'none' }
	it('refuses a page that is not on this computer', () => {
		expect(validateModules([{ ...base, page: { url: 'https://example.com/', startHint: 'x' } }])[0]).toMatch(/not a page on this computer/)
	})
	it('wants a tool or a reason, not both and not neither', () => {
		expect(validateModules([{ ...base, noAgentTool: undefined }])[0]).toMatch(/one of the two/)
	})
	it('refuses two modules with one name', () => {
		expect(validateModules([base, base])[0]).toMatch(/Two modules/)
	})
	it('refuses a command that is itself a parameter, and a parameter inside text', () => {
		const tool = { name: 't', description: '', argv: ['{cmd}', '--x={v}'], params: { cmd: { type: 'string' as const, description: '' }, v: { type: 'string' as const, description: '' } } }
		const problems = validateModules([{ ...base, noAgentTool: undefined, agentTool: tool }]).join(' ')
		expect(problems).toMatch(/command itself is fixed/)
		expect(problems).toMatch(/whole argument/)
	})
})

describe('isLoopbackUrl', () => {
	it('knows this computer', () => {
		expect(isLoopbackUrl('http://127.0.0.1:8791/')).toBe(true)
		expect(isLoopbackUrl('http://localhost:8795/x')).toBe(true)
		expect(isLoopbackUrl('https://127.0.0.1/')).toBe(false)
		expect(isLoopbackUrl('http://127.0.0.1.example.com/')).toBe(false)
		expect(isLoopbackUrl('file:///etc/passwd')).toBe(false)
		expect(isLoopbackUrl('nonsense')).toBe(false)
	})
})

describe('buildArgv', () => {
	const tool = findModule('library')!.agentTool!
	it('puts each value in as one whole argument', () => {
		expect(buildArgv(tool, { query: 'a dj; rm -rf ~ "quoted"', count: 3 }))
			.toEqual(['studio', 'lib', 'find', 'a dj; rm -rf ~ "quoted"', '--json', '-n', '3'])
	})
	it('uses the default, and asks for what is required', () => {
		expect(buildArgv(tool, { query: 'crowd' }).slice(-2)).toEqual(['-n', '10'])
		expect(() => buildArgv(tool, {})).toThrow(/needs "query"/)
		expect(() => buildArgv(tool, { query: '   ' })).toThrow(/needs "query"/)
	})
	it('refuses a value that would be read as a flag, or the wrong kind', () => {
		expect(() => buildArgv(tool, { query: '--include-private' })).toThrow(/may not start with "-"/)
		expect(() => buildArgv(tool, { query: 'x', count: 'many' })).toThrow(/whole number/)
		expect(() => buildArgv(tool, { query: 42 })).toThrow(/must be text/)
	})
})

describe('toolInputSchema', () => {
	it('lists the parameters and which are required', () => {
		const schema = toolInputSchema(findModule('library')!.agentTool!) as any
		expect(Object.keys(schema.properties)).toEqual(['query', 'count'])
		expect(schema.required).toEqual(['query'])
		expect(schema.additionalProperties).toBe(false)
	})
	it('is one tool per module that names one', () => {
		expect(MODULES.filter((m) => m.agentTool).map((m) => m.agentTool!.name)).toEqual(['library_find', 'review_notes'])
	})
})

describe('buildArgv, the edges', () => {
	const find = findModule('library')!.agentTool!
	const notes = findModule('review')!.agentTool!
	it('keeps a count inside its bounds and takes only a number or digits', () => {
		for (const bad of [0, -1, 1.5, 1e9, 51, true, [5], ' ', '5x', '1e2']) {
			expect(() => buildArgv(find, { query: 'x', count: bad }), String(bad)).toThrow(/whole number from 1 to 50/)
		}
		expect(buildArgv(find, { query: 'x', count: '7' }).at(-1)).toBe('7')
		expect(buildArgv(find, { query: 'x', count: 50 }).at(-1)).toBe('50')
	})
	it('refuses a line break, a control character and a dash behind spaces', () => {
		expect(() => buildArgv(find, { query: 'a\nb' })).toThrow(/line break/)
		expect(() => buildArgv(find, { query: 'a\u0000b' })).toThrow(/control character/)
		expect(() => buildArgv(find, { query: '   --all' })).toThrow(/may not start with "-"/)
	})
	it('wants a full path where a path is asked for', () => {
		expect(() => buildArgv(notes, { piece: 'runs/x' })).toThrow(/full path/)
		expect(buildArgv(notes, { piece: '/Users/a/piece' })).toEqual(['studio', 'review', 'notes', '/Users/a/piece', '--json'])
	})
	it('puts the bounds in the schema an agent is shown', () => {
		expect((toolInputSchema(find) as any).properties.count).toMatchObject({ minimum: 1, maximum: 50, default: 10 })
	})
})

describe('every command in the list is the studio command', () => {
	it('for tools and for pages', () => {
		for (const m of MODULES) {
			if (m.agentTool) expect(m.agentTool.argv[0], m.id).toBe('studio')
			if (m.page?.start) expect(m.page.start[0], m.id).toBe('studio')
		}
	})
	it('and the list refuses any other', () => {
		const base: StudioModule = { id: 'x', label: 'X', icon: 'i', workspace: 'review', kind: 'page', about: '', page: { url: 'http://127.0.0.1:1/', startHint: 'x', start: ['rm', '-rf'] }, noAgentTool: 'none' }
		expect(validateModules([base]).join(' ')).toMatch(/started by a `studio` command/)
		const tool = { name: 't', description: '', argv: ['sh', '{a}'], params: { a: { type: 'string' as const, description: '' } } }
		expect(validateModules([{ ...base, page: { url: 'http://127.0.0.1:1/', startHint: 'x' }, noAgentTool: undefined, agentTool: tool }]).join(' ')).toMatch(/runs a `studio` command/)
	})
})
