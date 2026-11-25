# The studio frame

FrameFlow's editor is one workspace of four. The frame is the thin layer around it: a bar of workspaces, one list of
modules, and a host that shows local pages inside the app. It is our own layer in our own files, so the fork keeps
merging with the original.

| Workspace | What is in it today |
|---|---|
| Shoot | Monitor: a live camera picture (one camera) |
| Story | Story: a door into a project's Story view. Library: the footage search page |
| Edit | The app as it was: Home, a project's editor, Settings |
| Review | Piece review and Review folder: the review pages |

Shoot, Story and Review open with no project and before the editor's set-up (a Gemini key, a projects folder).

## A module is one entry in one file
`src/shared/studio/modules.ts` is the list. An entry says which workspace the module is in and what the window shows:

- `kind: 'page'`: a local page (`http://127.0.0.1:<port>/`), framed in the app when its server answers. With `start`
  the app can start the command that serves it; without it the app shows the command to type.
- `kind: 'panel'`: a panel the app draws. Add the component under `src/renderer/src/studio/panels/` and its name to
  `src/renderer/src/studio/panels.ts`.
- `kind: 'editor'`: a door into the editor (Story opens a project with the Story view in front).

The same entry gives the module its tool for an agent: `agentTool` is a `studio` command with named parameters, and
`src/main/studio/agentTools.ts` turns it into an MCP tool. A module with no tool says why (`noAgentTool`); the tests
refuse an entry with neither. Two tools come with the list itself: `list_studio_modules` and `show_studio_module`.

Rules the tests hold:
- A page is on this computer only (http, 127.0.0.1 or localhost).
- A tool's command is fixed. A parameter is one whole argument, never part of one, and may not start with `-`.
- A tool's command is `studio` and nothing else. A whole number has bounds; text may not hold a line break.
- These tools never claim the editor's project, so they answer with no project open and while another agent holds it.
  One command runs at a time. `show_studio_module` moves the window, so it needs the edit permission and is refused
  while an agent holds a round or the chat is running, as `open_project` is.

The work is never in the app. A module is a view over a `studio` command or a page that command serves, so an agent
can do the same work with no window.

## Where it lives
| File | What |
|---|---|
| `src/shared/studio/modules.ts` (+ test) | The list, and its pure rules |
| `src/main/studio/index.ts` | Is a page answering, start its command, the camera question, the tools' hands |
| `src/main/studio/agentTools.ts` (+ test) | MCP tools made from the list |
| `src/preload/studio.ts` | `window.studio`, apart from the editor's `window.api` |
| `src/renderer/src/studio/` | The bar, the workspace page, the page host, the editor door, the panels |
| `src/shared/monitor.ts` (+ test) | Monitor's rules: which camera opens by itself |

Hooked into the app in seven places, each one or a few lines: `App.vue` (the bar above the pages), `router.ts` (one
route; workspaces skip the set-up check), `index.html` (the page may frame `http://127.0.0.1` and `localhost`),
`tailwind.config.js` (icons named in the list), `main/index.ts` (`initStudio()`), `mcp/index.ts` (the list's tools
join the editor's), `preload/index.ts` (one import). Packaging: the camera sentence and the camera right for macOS.

## Not in this version
- The chat assistant inside the editor does not get the list's tools: its tool list is built in a file the original
  changes often. Outside agents (the MCP server) get them.
- Every camera at once, feeds over the network, record and settings: the full Monitor.
- A script editor, Prompter controls, the take log.
- Starting a page that needs a choice (which piece to review): the app shows the command instead.
- The Story view is still an overlay inside the editor, opened through the door.
