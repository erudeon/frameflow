import { createRouter, createWebHashHistory } from 'vue-router'
import SetupPage from './pages/SetupPage.vue'
import SettingsPage from './pages/SettingsPage.vue'
import HomePage from './pages/HomePage.vue'

import GraphChatPage from './pages/GraphChatPage.vue'
import VideoEditorPage from './editor/VideoEditorPage.vue'
import WorkspacePage from './studio/WorkspacePage.vue'
import { isStudioPath } from './studio/nav'

const routes = [
	{
		path: '/',
		redirect: '/home'
	},
	{
		path: '/home',
		component: HomePage
	},
	{
		path: '/setup',
		component: SetupPage
	},
	{
		path: '/chat/:id',
		name: 'chat',
		component: GraphChatPage
	},
	{
		path: '/editor/:id',
		name: 'editor',
		component: VideoEditorPage
	},

	{
		path: '/settings',
		component: SettingsPage
	},
	// The studio's workspaces (Shoot, Story, Review). Edit is the routes above.
	{
		path: '/studio/:workspace/:module?',
		name: 'studio',
		component: WorkspacePage
	}
]

const router = createRouter({
	history: createWebHashHistory(),
	routes
})

// Setup guard: a Gemini key and a projects folder the OS will not clear.
// Main decides (settingsManager.isSetupComplete), so installs that predate the
// wizard and already have both are never sent through it.
router.beforeEach(async (to) => {
	// The studio's workspaces need neither: a camera or a review page has no use for a key.
	if (isStudioPath(to.path)) return true
	const complete: boolean = await (window as any).api.isSetupComplete()
	if (to.path === '/setup') return complete ? '/home' : true
	return complete ? true : '/setup'
})

export default router
