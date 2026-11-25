import { ref } from 'vue'
import type { Router } from 'vue-router'
import { findModule, isWorkspaceId, modulesOf, type WorkspaceId } from '@shared/studio/modules'

/**
 * Where the workspaces are in the app's routes.
 *
 * Edit is the app as it was: Home, a project's editor, Settings, the chat page.
 * The other three are one route, `/studio/<workspace>/<module>`. Nothing of the
 * editor's own pages changes; the bar only remembers where Edit was left, so
 * coming back lands on the same project.
 */

export const STUDIO_PREFIX = '/studio/'

/** Workspaces open without the editor's set-up (a Gemini key, a projects folder). */
export const isStudioPath = (path: string): boolean => path.startsWith(STUDIO_PREFIX)

export const workspaceOfPath = (path: string): WorkspaceId => {
	if (!isStudioPath(path)) return 'edit'
	const id = path.slice(STUDIO_PREFIX.length).split('/')[0]
	return isWorkspaceId(id) && id !== 'edit' ? id : 'edit'
}

/** The last place in Edit; Home until the person has been somewhere. */
export const lastEditPath = ref('/home')

export const rememberEditPath = (path: string) => {
	if (!isStudioPath(path) && path !== '/' && path !== '/setup') lastEditPath.value = path
}

export const pathOfWorkspace = (workspace: WorkspaceId): string => {
	if (workspace === 'edit') return lastEditPath.value
	const first = modulesOf(workspace)[0]
	return `${STUDIO_PREFIX}${workspace}${first ? `/${first.id}` : ''}`
}

/** The route that shows one module (an agent asked, or a row was clicked). */
export const pathOfModule = (moduleId: string): string | null => {
	const m = findModule(moduleId)
	if (!m) return null
	return m.workspace === 'edit' ? lastEditPath.value : `${STUDIO_PREFIX}${m.workspace}/${m.id}`
}

let following = false

/** Once per window: a hot reload mounts the bar again, and must not add a second hook. */
export const followRouter = (router: Router) => {
	rememberEditPath(router.currentRoute.value.path)
	if (following) return
	following = true
	router.afterEach((to) => rememberEditPath(to.fullPath))
}
