'use strict'

/*
 * A doorbell without camera. Apple Home shows a doorbell (tile, "Cameras & Doorbells", ring
 * notification and chime) only as part of a camera; a Doorbell service on its own is "not
 * supported". So the doorbell gets hap's DoorbellController, a camera controller with the doorbell
 * as primary service, whose camera delivers a still image as snapshot and as live video: the
 * picture is sent as an H.264 stream made in JavaScript (StillStream.js), there is no ffmpeg on
 * the CCU. Without a stream Apple Home showed a crossed out camera when the tile was opened.
 * A video doorbell requires a microphone and a speaker (HAP 11.3.2), without them Apple Home
 * showed the camera but never asked for a snapshot: the audio options make hap add both, although
 * no audio is ever streamed.
 */

const path = require('path')
const { DoorbellController, SRTPCryptoSuites, H264Profile, H264Level, AudioStreamingCodecType, AudioStreamingSamplerate, Service, Characteristic, StreamRequestTypes, CameraController } = require('@homebridge/hap-nodejs')
const udpPort = require(path.join(__dirname, 'udpPort.js'))
const { watchdogSeconds } = require(path.join(__dirname, 'rtcpWatchdog.js'))
const { StillStream, streamSize } = require(path.join(__dirname, 'StillStream.js'))

// level_idc of the H264Level HomeKit chose
const LEVEL_IDC = { [H264Level.LEVEL3_1]: 31, [H264Level.LEVEL3_2]: 32, [H264Level.LEVEL4_0]: 40 }
const WATCHDOG_FLOOR_SECONDS = 10

const STREAMING_OPTIONS = {
  supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
  video: {
    codec: {
      profiles: [H264Profile.BASELINE, H264Profile.MAIN],
      levels: [H264Level.LEVEL3_1, H264Level.LEVEL4_0]
    },
    // the sizes Apple Home asks snapshots in (320x240 for the Apple Watch)
    resolutions: [[1920, 1080, 30], [1280, 720, 30], [640, 360, 30], [480, 270, 30], [320, 240, 15]]
  },
  // the audio of a video doorbell (microphone and speaker, see above); never streamed
  audio: {
    twoWayAudio: true,
    codecs: [
      { type: AudioStreamingCodecType.OPUS, samplerate: [AudioStreamingSamplerate.KHZ_16, AudioStreamingSamplerate.KHZ_24] },
      { type: AudioStreamingCodecType.AAC_ELD, samplerate: AudioStreamingSamplerate.KHZ_16 }
    ]
  }
}

class StillImageDelegate {
  /**
   * @param {{snapshot: function(number, number): Promise<Buffer>, frame: function(number, number, number): Promise<object>}} stillImage
   *   JPEG and H.264 per size (util/doorbellImage.js StillImage)
   * @param {string} name for the log
   * @param {object} log
   * @param {object} options for tests: bindReturnSocket, bindUdpSocket, watchdogFloorSeconds
   */
  constructor (stillImage, name, log, options = {}) {
    this.stillImage = stillImage
    this.name = name
    this.log = log
    this.logged = new Set()
    this.bindReturnSocket = options.bindReturnSocket || udpPort.bindReturnSocket
    this.bindUdpSocket = options.bindUdpSocket || udpPort.bindUdpSocket
    this.watchdogFloorSeconds = options.watchdogFloorSeconds !== undefined ? options.watchdogFloorSeconds : WATCHDOG_FLOOR_SECONDS
    this.sessions = new Map()
  }

  /** the controller stops a session whose viewer went away */
  attachController (controller) {
    this.controller = controller
  }

  // the first request of a kind goes into the log, the others only in debug mode
  logRequest (kind, message, ...args) {
    const level = this.logged.has(kind) ? 'debug' : 'info'
    this.logged.add(kind)
    this.log[level](message, ...args)
  }

  handleSnapshotRequest (request, callback) {
    this.logRequest('snapshot', '[Doorbell %s] Apple Home asks for a snapshot %sx%s', this.name, request.width, request.height)
    this.stillImage.snapshot(request.width, request.height).then(
      (jpg) => callback(undefined, jpg),
      (error) => {
        this.log.error('[Doorbell %s] snapshot failed: %s', this.name, error.message)
        callback(error)
      })
  }

  /**
   * The ports the viewer sends RTCP (video) and talkback (audio) to. The video port comes from
   * the range the CCU firewall opens while there is a video doorbell (udpPort.js), any other when
   * it is taken; no audio is received, its port is any free one.
   */
  prepareStream (request, callback) {
    const video = this.bindReturnSocket(request.addressVersion).catch(() => this.bindUdpSocket(request.addressVersion, 0))
    Promise.allSettled([video, this.bindUdpSocket(request.addressVersion, 0)])
      .then(([videoSocket, audioSocket]) => {
        const failure = [videoSocket, audioSocket].find(result => result.status === 'rejected')
        if (failure) {
          [videoSocket, audioSocket].filter(result => result.status === 'fulfilled').forEach(result => result.value.close())
          throw failure.reason
        }
        const session = {
          address: request.targetAddress,
          videoPort: request.video.port,
          videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
          videoSSRC: CameraController.generateSynchronisationSource(),
          audioSSRC: CameraController.generateSynchronisationSource(),
          socket: videoSocket.value,
          audioSocket: audioSocket.value
        }
        const ignore = (error) => this.log.debug('[Doorbell %s] stream socket: %s', this.name, error.message)
        session.socket.on('error', ignore)
        session.audioSocket.on('error', ignore)
        this.sessions.set(request.sessionID, session)
        callback(undefined, {
          video: { port: session.socket.address().port, ssrc: session.videoSSRC, srtp_key: request.video.srtp_key, srtp_salt: request.video.srtp_salt },
          audio: { port: session.audioSocket.address().port, ssrc: session.audioSSRC, srtp_key: request.audio.srtp_key, srtp_salt: request.audio.srtp_salt }
        })
      })
      .catch((error) => {
        this.log.error('[Doorbell %s] preparing the live video failed: %s', this.name, error.message)
        callback(error)
      })
  }

  handleStreamRequest (request, callback) {
    switch (request.type) {
      case StreamRequestTypes.START:
        this.startStream(request, callback)
        break
      case StreamRequestTypes.STOP:
        this.stopStream(request.sessionID)
        callback()
        break
      default:
        // RECONFIGURE: the picture stays the same at every size
        callback()
    }
  }

  startStream (request, callback) {
    const session = this.sessions.get(request.sessionID)
    if (!session) {
      callback(new Error(`no prepared session ${request.sessionID}`))
      return
    }
    const size = streamSize(request.video.width, request.video.height)
    const levelIdc = LEVEL_IDC[request.video.level] || 31
    this.logRequest('stream', '[Doorbell %s] Apple Home asks for live video %sx%s, sending the picture as %sx%s', this.name, request.video.width, request.video.height, size.width, size.height)
    // Apple Home waits for the first frame, the picture is rendered meanwhile
    callback()
    this.stillImage.frame(size.width, size.height, levelIdc).then((frame) => {
      if (this.sessions.get(request.sessionID) !== session) {
        return
      }
      session.stream = new StillStream({
        frame,
        socket: session.socket,
        address: session.address,
        port: session.videoPort,
        ssrc: session.videoSSRC,
        srtp: session.videoSRTP,
        payloadType: request.video.pt,
        mtu: request.video.mtu,
        fps: request.video.fps,
        maxBitRate: request.video.max_bit_rate,
        onError: (error) => this.log.debug('[Doorbell %s] sending the live video: %s', this.name, error.message)
      })
      session.stream.start()
      this.watchViewer(request.sessionID, session, watchdogSeconds(request.video.rtcp_interval, this.watchdogFloorSeconds))
    }, (error) => {
      this.log.error('[Doorbell %s] the picture for the live video failed: %s', this.name, error.message)
      this.abortSession(request.sessionID)
    })
  }

  /**
   * Ends a session whose viewer stopped sending RTCP. The watchdog starts with the first RTCP:
   * a firewall that drops it (the CCU opens the ports only for a video doorbell) must not end
   * the stream; Apple Home then stops it itself, or hap when the viewer disconnects.
   */
  watchViewer (sessionID, session, seconds) {
    const arm = () => {
      clearTimeout(session.watchdog)
      session.watchdog = setTimeout(() => {
        this.log.info('[Doorbell %s] no RTCP from the viewer for %ss, stopping the live video', this.name, seconds)
        this.abortSession(sessionID)
      }, seconds * 1000)
    }
    session.socket.on('message', arm)
  }

  abortSession (sessionID) {
    this.stopStream(sessionID)
    if (this.controller) {
      this.controller.forceStopStreamingSession(sessionID)
    }
  }

  stopStream (sessionID) {
    const session = this.sessions.get(sessionID)
    if (!session) {
      return
    }
    this.sessions.delete(sessionID)
    clearTimeout(session.watchdog)
    if (session.stream) {
      session.stream.stop()
    }
    session.socket.close()
    session.audioSocket.close()
    this.log.debug('[Doorbell %s] live video %s stopped', this.name, sessionID)
  }

  /** stops every live video (shutdown) */
  shutdown () {
    [...this.sessions.keys()].forEach(sessionID => this.stopStream(sessionID))
  }
}

/**
 * Makes the HomeKit accessory a doorbell with a still image.
 * @param {object} accessory hap Accessory
 * @param {object} stillImage see StillImageDelegate
 * @param {string} name
 * @param {object} log
 * @returns {{controller: object, ring: function, shutdown: function}} ring() sends a ring to
 *   Apple Home, shutdown() stops the live videos
 */
function configureStillDoorbell (accessory, stillImage, name, log) {
  const delegate = new StillImageDelegate(stillImage, name, log)
  const controller = new DoorbellController({
    // HAP asks for at least two stream sessions
    cameraStreamCount: 2,
    delegate,
    streamingOptions: STREAMING_OPTIONS,
    name
  })
  delegate.attachController(controller)
  accessory.configureController(controller)
  // a doorbell only rings: HAP knows SINGLE_PRESS alone for the Doorbell service
  const { SINGLE_PRESS } = Characteristic.ProgrammableSwitchEvent
  accessory.getService(Service.Doorbell).getCharacteristic(Characteristic.ProgrammableSwitchEvent)
    .setProps({ minValue: SINGLE_PRESS, maxValue: SINGLE_PRESS, validValues: [SINGLE_PRESS] })
  return { controller, ring: () => controller.ringDoorbell(), shutdown: () => delegate.shutdown() }
}

module.exports = { configureStillDoorbell, StillImageDelegate, STREAMING_OPTIONS }
