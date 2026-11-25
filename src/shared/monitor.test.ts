import { describe, expect, it } from 'vitest'
import { accessAllows, cameraKind, cameraName, constraintsFor, describeFeed, pickAutoCamera, sortCameras } from './monitor'

const cam = (label: string, deviceId = label || 'id') => ({ deviceId, label })

describe('cameraKind', () => {
	it('knows the studio camera and this computer', () => {
		expect(cameraKind('OsmoPocket3')).toBe('studio')
		expect(cameraKind('OsmoPocket3 (2ca3:0023)')).toBe('studio')
		expect(cameraKind('FaceTime HD Camera')).toBe('builtin')
		expect(cameraKind('FaceTime HD Camera (Built-in)')).toBe('builtin')
	})
	it('calls everything else other, phones included', () => {
		expect(cameraKind('Studio Phone A Camera')).toBe('other')
		expect(cameraKind('OBS Virtual Camera')).toBe('other')
		expect(cameraKind('')).toBe('other')
	})
})

describe('cameraName', () => {
	it('drops the USB id the browser adds, and nothing else', () => {
		expect(cameraName('FaceTime HD Camera (3A71:F4B5)')).toBe('FaceTime HD Camera')
		expect(cameraName('OsmoPocket3 (2ca3:0023)')).toBe('OsmoPocket3')
		expect(cameraName('FaceTime HD Camera (Built-in)')).toBe('FaceTime HD Camera (Built-in)')
		expect(cameraName('Studio Phone A Camera')).toBe('Studio Phone A Camera')
	})
})

describe('pickAutoCamera', () => {
	it('takes the studio camera over this computer', () => {
		const picked = pickAutoCamera([cam('FaceTime HD Camera'), cam('Studio Phone A Camera'), cam('OsmoPocket3')])
		expect(picked?.label).toBe('OsmoPocket3')
	})
	it('falls back to this computer', () => {
		expect(pickAutoCamera([cam('Studio Phone A Camera'), cam('FaceTime HD Camera')])?.label).toBe('FaceTime HD Camera')
	})
	it('never opens a phone or an unknown camera by itself', () => {
		expect(pickAutoCamera([cam('Studio Phone A Camera'), cam('Studio Phone B Camera')])).toBeNull()
	})
	it('opens nothing while names are hidden', () => {
		expect(pickAutoCamera([cam('', 'a'), cam('', 'b')])).toBeNull()
		expect(pickAutoCamera([])).toBeNull()
	})
})

describe('sortCameras', () => {
	it('lists studio, then this computer, then the rest by name', () => {
		const sorted = sortCameras([cam('Zed Cam'), cam('FaceTime HD Camera'), cam('Alpha Phone Camera'), cam('OsmoPocket3')])
		expect(sorted.map((c) => c.label)).toEqual(['OsmoPocket3', 'FaceTime HD Camera', 'Alpha Phone Camera', 'Zed Cam'])
	})
})

describe('constraintsFor', () => {
	it('always names one exact camera', () => {
		const video = constraintsFor(cam('FaceTime HD Camera', 'abc')).video as MediaTrackConstraints
		expect(video.deviceId).toEqual({ exact: 'abc' })
		expect(constraintsFor(cam('x')).audio).toBe(false)
	})
	it('asks the studio camera for the size it records at', () => {
		const video = constraintsFor(cam('OsmoPocket3')).video as MediaTrackConstraints
		expect(video.width).toEqual({ ideal: 3840 })
		expect(video.height).toEqual({ ideal: 2160 })
		expect(video.frameRate).toEqual({ ideal: 25 })
	})
})

describe('describeFeed and accessAllows', () => {
	it('reads as a size and a rate', () => {
		expect(describeFeed(1280, 720, 29.97)).toBe('1280 × 720 · 30 fps')
		expect(describeFeed(1280, 720, 0)).toBe('1280 × 720')
		expect(describeFeed(0, 0, 0)).toBe('Waiting for the picture')
	})
	it('opens only when allowed, or where the OS has no switch', () => {
		expect(accessAllows('granted')).toBe(true)
		expect(accessAllows('unknown')).toBe(true)
		expect(accessAllows('denied')).toBe(false)
		expect(accessAllows('not-determined')).toBe(false)
		expect(accessAllows('restricted')).toBe(false)
	})
})
