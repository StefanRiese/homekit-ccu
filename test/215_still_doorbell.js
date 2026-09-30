'use strict'

// A doorbell without camera: hap's DoorbellController (a camera controller with the doorbell as
// primary service) whose camera delivers the still image as snapshot and as live video (the
// stream itself in 223_still_stream.js).

const path = require('path')
const expect = require('expect.js')
const jpeg = require('jpeg-js')
const { Accessory, Service, Characteristic, uuid } = require('@homebridge/hap-nodejs')
const { configureStillDoorbell, StillImageDelegate } = require(path.join(__dirname, '..', 'lib', 'services', 'camera', 'stillDoorbell.js'))

const stillImage = () => ({ snapshot: async (width, height) => jpeg.encode({ width, height, data: Buffer.alloc(width * height * 4, 200) }, 80).data })
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

describe('HomeKit-CCU doorbell with a still image', () => {
  // HAP 11.3.2: a video doorbell requires Camera RTP Stream Management, Microphone and Speaker;
  // without them Apple Home showed the camera but never asked for a snapshot
  it('is a complete video doorbell: doorbell as primary service, two streams, microphone and speaker', () => {
    const accessory = new Accessory('Door', uuid.generate('still-doorbell-1'))
    configureStillDoorbell(accessory, stillImage(), 'Door', log)
    const doorbell = accessory.getService(Service.Doorbell)
    expect(doorbell).to.be.ok()
    expect(doorbell.isPrimaryService).to.be(true)
    expect(accessory.services.filter(service => service.UUID === Service.CameraRTPStreamManagement.UUID).length).to.be(2)
    expect(accessory.getService(Service.Microphone)).to.be.ok()
    expect(accessory.getService(Service.Speaker)).to.be.ok()
  })

  it('logs the first snapshot and the first live video request, then only in debug mode', async () => {
    const lines = []
    const recording = { debug: () => {}, info: (...args) => lines.push(args.join(' ')), warn: () => {}, error: () => {} }
    const delegate = new StillImageDelegate({ ...stillImage(), frame: () => new Promise(() => {}) }, 'Door', recording, { liveVideo: true })
    const snapshot = () => new Promise(resolve => delegate.handleSnapshotRequest({ width: 64, height: 36 }, resolve))
    await snapshot()
    await snapshot()
    delegate.sessions.set('a', {})
    delegate.sessions.set('b', {})
    const start = (sessionID) => new Promise(resolve => delegate.handleStreamRequest({ sessionID, type: 'start', video: { width: 1280, height: 720 } }, resolve))
    await start('a')
    await start('b')
    expect(lines.length).to.be(2)
    expect(lines[0]).to.contain('snapshot')
    expect(lines[1]).to.contain('live video')
  })

  it('rings with SINGLE_PRESS, as often as it rings', () => {
    const accessory = new Accessory('Door', uuid.generate('still-doorbell-2'))
    const doorbell = configureStillDoorbell(accessory, stillImage(), 'Door', log)
    const events = []
    accessory.getService(Service.Doorbell).getCharacteristic(Characteristic.ProgrammableSwitchEvent)
      .on('change', change => events.push(change.newValue))
    doorbell.ring()
    doorbell.ring()
    expect(events).to.eql([0, 0])
    const props = accessory.getService(Service.Doorbell).getCharacteristic(Characteristic.ProgrammableSwitchEvent).props
    expect(props.validValues).to.eql([Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS])
  })

  it('answers a snapshot request with a JPEG of the requested size', async () => {
    const delegate = new StillImageDelegate(stillImage(), 'Door', log)
    const jpg = await new Promise((resolve, reject) => delegate.handleSnapshotRequest({ width: 640, height: 360 }, (error, buffer) => error ? reject(error) : resolve(buffer)))
    const image = jpeg.decode(jpg, { useTArray: true })
    expect([image.width, image.height]).to.eql([640, 360])
  })

  it('refuses live video unless "Picture as live video" is switched on', (done) => {
    const delegate = new StillImageDelegate(stillImage(), 'Door', log)
    delegate.prepareStream({ sessionID: 'a', addressVersion: 'ipv4' }, (error) => {
      expect(error).to.be.an(Error)
      expect(delegate.sessions.size).to.be(0)
      delegate.handleStreamRequest({ sessionID: 'a', type: 'stop' }, (stopError) => {
        expect(stopError).to.be(undefined)
        done()
      })
    })
  })

  it('passes "Picture as live video" of the settings to the camera', () => {
    const { liveVideo, IMAGE_SETTINGS } = require(path.join(__dirname, '..', 'lib', 'services', 'camera', 'doorbellSettings.js'))
    expect(IMAGE_SETTINGS.liveVideo.default).to.be(false)
    expect([undefined, false, 'false', true, 'true'].map(value => liveVideo(() => value))).to.eql([false, false, false, true, true])
    const off = configureStillDoorbell(new Accessory('Door', uuid.generate('still-doorbell-3')), stillImage(), 'Door', log)
    const on = configureStillDoorbell(new Accessory('Door', uuid.generate('still-doorbell-4')), stillImage(), 'Door', log, { liveVideo: true })
    expect(off.controller.delegate.liveVideo).to.be(false)
    expect(on.controller.delegate.liveVideo).to.be(true)
  })

  it('reports a failing snapshot as error', (done) => {
    const failing = { snapshot: async () => { throw new Error('boom') } }
    new StillImageDelegate(failing, 'Door', log).handleSnapshotRequest({ width: 1, height: 1 }, (error) => {
      expect(error).to.be.an(Error)
      done()
    })
  })
})
