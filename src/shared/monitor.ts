/**
 * Monitor: which camera the panel opens by itself, and how it asks for it.
 *
 * Pure, so the rules have tests and the panel only draws. Three rules:
 *
 * 1. The panel opens a camera by itself only when it knows what the camera is:
 *    the studio camera on its cable, or this computer's own camera. Anything
 *    else (a phone offered as a wireless camera, a virtual camera) is listed and
 *    opens only when the person picks it, because opening a phone as a camera
 *    takes it away from the app that is filming on it.
 * 2. A camera with no name has not been allowed yet: nothing is opened.
 * 3. The studio camera is asked for the size it records at. Its cable feed
 *    keeps the size it was last asked for, and its own card records at that
 *    size, so a preview that asks for a small picture would shrink the master.
 */

export type CameraKind = 'studio' | 'builtin' | 'other'

export interface CameraInfo {
	deviceId: string
	label: string
}

/** macOS answers for the camera; `unknown` where the OS has no such switch. */
export type CameraAccess = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'

/** The DJI Osmo Pocket 3 in webcam mode names itself "OsmoPocket3". */
const STUDIO = /osmo\s*pocket/i
const BUILTIN = /facetime|built-?in|integrated/i

export const cameraKind = (label: string): CameraKind =>
	STUDIO.test(label) ? 'studio' : BUILTIN.test(label) ? 'builtin' : 'other'

export const KIND_LABEL: Record<CameraKind, string> = {
	studio: 'Studio camera',
	builtin: 'This computer',
	other: 'Opens when picked'
}

/**
 * The camera to open without being asked: the studio camera, else this
 * computer's own. `null` when neither is there or names are still hidden.
 */
export function pickAutoCamera(cameras: CameraInfo[]): CameraInfo | null {
	const named = cameras.filter((c) => c.deviceId && c.label.trim())
	return named.find((c) => cameraKind(c.label) === 'studio')
		?? named.find((c) => cameraKind(c.label) === 'builtin')
		?? null
}

/** Studio first, then this computer, then the rest by name. */
export function sortCameras<T extends CameraInfo>(cameras: T[]): T[] {
	const rank: Record<CameraKind, number> = { studio: 0, builtin: 1, other: 2 }
	return [...cameras].sort((a, b) =>
		rank[cameraKind(a.label)] - rank[cameraKind(b.label)] || a.label.localeCompare(b.label))
}

/**
 * What to ask the browser for. Always one exact camera, never "any camera":
 * "any" may hand back a phone.
 */
export function constraintsFor(camera: CameraInfo): MediaStreamConstraints {
	const studio = cameraKind(camera.label) === 'studio'
	return {
		audio: false,
		video: {
			deviceId: { exact: camera.deviceId },
			...(studio
				? { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 25 } }
				: { width: { ideal: 1280 }, height: { ideal: 720 } })
		}
	}
}

/** The browser adds the USB id to a name ("FaceTime HD Camera (3A71:F4B5)"): a person does not need it. */
export const cameraName = (label: string): string =>
	label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').trim()

/** "1280 × 720 · 30 fps", from what the camera settled on and what was counted. */
export function describeFeed(width: number, height: number, fps: number): string {
	if (!width || !height) return 'Waiting for the picture'
	const rate = fps > 0 ? ` · ${Math.round(fps)} fps` : ''
	return `${width} × ${height}${rate}`
}

/** May the panel try to open a camera at all? */
export const accessAllows = (access: CameraAccess): boolean => access === 'granted' || access === 'unknown'
