# Monitor

A left-rail tab that shows a live camera picture. A first, small module: it proves how a new tab is added to the
editor and what a camera needs from the app. It records nothing and never touches the project.

## What it does
- Lists every camera the computer offers, studio camera first.
- Opens one by itself only when it knows what it is: the studio camera on its cable (it names itself
  "OsmoPocket3"), else this computer's own camera. Any other camera (a phone offered as a wireless camera, a virtual
  camera) opens only when picked: opening a phone as a camera takes it away from the app that is filming on it.
- Always asks for one exact camera, never "any camera".
- Asks the studio camera for 3840 x 2160 at 25 fps, the size it records at. Its cable feed keeps the size it was
  last asked for and its own card records at that size, so a small preview would shrink the master. (From the shoot
  notes of 24 Nov 2026; not yet run with the camera plugged in.)
- Shows the size and frame rate it measured, not what it asked for.
- Holds the camera only while the tab is on screen. Another tab, Inspect or a collapsed panel lets it go.

## Where it lives
| File | What |
|---|---|
| `src/shared/monitor.ts` (+ test) | The rules: which camera opens by itself, what to ask it for, how a feed reads |
| `src/renderer/src/editor/components/MonitorPanel.vue` | The panel |
| `src/renderer/src/editor/components/LeftPanel.vue` | The tab: one more name in `LeftTab`, one row in `TABS`, one import, one line in the template |
| `src/main/monitor/ipc.ts`, `src/main/index.ts`, `src/preload/index.ts` | The operating system's answer on the camera (`cameraAccess`, `openCameraSettings`) |
| `electron-builder.yml`, `build/entitlements.mac.plist` | macOS: the sentence shown when it asks, and the right to use a camera under the hardened runtime |

## Not in this version
- More than one picture at a time, and a full-size view: the left panel is 200 to 440 px wide.
- Feeds that arrive over the network (a phone streaming into a local media server). The page's content security
  policy allows connections to the app itself only, so that needs a decision, not just a URL.
- Sound levels, record, camera settings.
- Tools for an agent. Monitor does not change the project, so it needs none of the editor bridge.

## Running a copy beside the installed app
An unpackaged copy writes to the installed app's data folder unless it is given its own:
`FRAMEFLOW_USER_DATA=/some/folder electron out/main/index.js`.
A copy started from a terminal uses the camera permission of whatever started it.
