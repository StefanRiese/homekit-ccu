'use strict'

/*
 * The live video of a doorbell without camera: its still image as an H.264 stream over SRTP
 * (h264Still.js, srtp.js), without ffmpeg. The IDR frame carries the picture uncompressed and is
 * large (about 350 kB at 640x360), the frames between repeat it with a few bytes. So the IDR frame
 * is sent again only as often as the bit rate Apple Home asked for allows, and its packets are
 * paced instead of sent in one burst. An RTCP sender report goes out every second.
 */

const path = require('path')
const { skipFrame, frameGeometry } = require(path.join(__dirname, 'h264Still.js'))
const { SrtpSender } = require(path.join(__dirname, 'srtp.js'))

// the stream is never larger: Apple Home scales it up, and the IDR frame stays sendable
const MAX_WIDTH = 640
const MAX_HEIGHT = 480
const MAX_FPS = 10
const RTP_CLOCK = 90000
const RTP_HEADER_BYTES = 12
const SRTP_TAG_BYTES = 10
const FU_A = 28
// the IDR frame again after 1 s (a first one lost shows nothing), then as the bit rate allows
const SECOND_IDR_MS = 1000
const MIN_IDR_INTERVAL_MS = 2000
const MAX_IDR_INTERVAL_MS = 20000
// pacing: packets per tick of PACE_MS, about 15 Mbit/s
const PACE_MS = 10
const PACKETS_PER_TICK = 14
const SENDER_REPORT_MS = 1000
// seconds between 1900 (NTP) and 1970
const NTP_OFFSET = 2208988800

/** the size of the stream: the one asked for, made smaller to MAX_WIDTH x MAX_HEIGHT, even */
function streamSize (width, height) {
  const scale = Math.min(1, MAX_WIDTH / width, MAX_HEIGHT / height)
  const even = (value) => Math.max(2, 2 * Math.round(value * scale / 2))
  return { width: even(width), height: even(height) }
}

/** milliseconds between IDR frames: the IDR frame may take at most the bit rate asked for */
function idrIntervalMs (idrBytes, maxBitRateKbit) {
  const rate = (maxBitRateKbit > 0 ? maxBitRateKbit : 300) * 1000
  const ms = Math.ceil(8 * idrBytes / rate * 1000)
  return Math.min(Math.max(ms, MIN_IDR_INTERVAL_MS), MAX_IDR_INTERVAL_MS)
}

/**
 * The RTP payloads of a NAL unit (RFC 6184): the unit itself when it fits, else FU-A fragments.
 * @returns {Buffer[]}
 */
function rtpPayloads (nal, maxPayload) {
  if (nal.length <= maxPayload) {
    return [nal]
  }
  const indicator = (nal[0] & 0xE0) | FU_A
  const type = nal[0] & 0x1F
  const payloads = []
  const chunk = maxPayload - 2
  for (let start = 1; start < nal.length; start += chunk) {
    const end = Math.min(start + chunk, nal.length)
    const header = (start === 1 ? 0x80 : 0) | (end === nal.length ? 0x40 : 0) | type
    payloads.push(Buffer.concat([Buffer.from([indicator, header]), nal.subarray(start, end)]))
  }
  return payloads
}

/**
 * One live video session.
 * options: {
 *   frame: h264Still.js encodeStill of the stream size,
 *   socket: dgram socket the packets are sent from,
 *   address, port: where the viewer receives the video,
 *   ssrc, srtp (master key and salt), payloadType, mtu, fps, maxBitRate: of the START request,
 *   now (for tests)
 * }
 */
class StillStream {
  constructor (options) {
    this.frame = options.frame
    this.geometry = frameGeometry(this.frame.width, this.frame.height)
    this.socket = options.socket
    this.address = options.address
    this.port = options.port
    this.ssrc = options.ssrc >>> 0
    this.srtp = new SrtpSender(options.srtp)
    this.payloadType = options.payloadType
    this.maxPayload = Math.max(100, (options.mtu || 1378) - RTP_HEADER_BYTES - SRTP_TAG_BYTES)
    this.frameMs = 1000 / Math.min(Math.max(options.fps || MAX_FPS, 1), MAX_FPS)
    this.idrIntervalMs = idrIntervalMs(this.frame.idr.length, options.maxBitRate)
    this.now = options.now || Date.now
    this.onError = options.onError || (() => {})
    this.sequence = Math.floor(Math.random() * 65536)
    this.rollover = 0
    this.timestampBase = Math.floor(Math.random() * 2 ** 32)
    this.queue = []
    this.packets = 0
    this.octets = 0
    this.timers = []
  }

  start () {
    this.startedAt = this.now()
    this.nextIdrAt = this.startedAt
    this.idrCount = 0
    this.timers.push(setInterval(() => this.nextFrame(), this.frameMs))
    this.timers.push(setInterval(() => this.sendQueued(), PACE_MS))
    this.timers.push(setInterval(() => this.senderReport(), SENDER_REPORT_MS))
    this.nextFrame()
    this.sendQueued()
  }

  stop () {
    this.timers.forEach(timer => clearInterval(timer))
    this.timers = []
    this.queue = []
    this.stopped = true
  }

  /** the RTP time of now */
  rtpTimestamp () {
    return (this.timestampBase + Math.round((this.now() - this.startedAt) * RTP_CLOCK / 1000)) % 2 ** 32
  }

  /** queues the next access unit: the IDR frame when it is due, else a skipped frame */
  nextFrame () {
    // a frame waits while the IDR frame is still being sent: frames are never queued up
    if (this.queue.length > 0) {
      return
    }
    const timestamp = this.rtpTimestamp()
    const now = this.now()
    let units
    if (now >= this.nextIdrAt) {
      units = [this.frame.sps, this.frame.pps, this.frame.idr]
      this.idrCount++
      this.nextIdrAt = now + (this.idrCount === 1 ? SECOND_IDR_MS : this.idrIntervalMs)
      this.sinceIdr = 0
    } else {
      units = [skipFrame(this.geometry, ++this.sinceIdr)]
    }
    const payloads = units.flatMap(unit => rtpPayloads(unit, this.maxPayload))
    payloads.forEach((payload, i) => this.queue.push({ payload, timestamp, marker: i === payloads.length - 1 }))
  }

  sendQueued () {
    for (let i = 0; i < PACKETS_PER_TICK && this.queue.length > 0; i++) {
      const { payload, timestamp, marker } = this.queue.shift()
      this.sendRtp(payload, timestamp, marker)
    }
  }

  sendRtp (payload, timestamp, marker) {
    const header = Buffer.alloc(RTP_HEADER_BYTES)
    header[0] = 0x80
    header[1] = (marker ? 0x80 : 0) | this.payloadType
    header.writeUInt16BE(this.sequence, 2)
    header.writeUInt32BE(timestamp >>> 0, 4)
    header.writeUInt32BE(this.ssrc, 8)
    this.send(this.srtp.protectRtp(Buffer.concat([header, payload]), this.rollover))
    this.packets++
    this.octets += payload.length
    this.lastTimestamp = timestamp
    this.sequence = (this.sequence + 1) % 65536
    if (this.sequence === 0) {
      this.rollover++
    }
  }

  /** an RTCP sender report (RFC 3550 6.4.1), so the viewer can place the frames in time */
  senderReport () {
    if (this.packets === 0) {
      return
    }
    const report = Buffer.alloc(28)
    report[0] = 0x80
    report[1] = 200
    report.writeUInt16BE(6, 2)
    report.writeUInt32BE(this.ssrc, 4)
    const ms = this.now()
    const seconds = Math.floor(ms / 1000)
    report.writeUInt32BE((seconds + NTP_OFFSET) >>> 0, 8)
    report.writeUInt32BE(Math.floor((ms % 1000) / 1000 * 2 ** 32) >>> 0, 12)
    report.writeUInt32BE(this.rtpTimestamp() >>> 0, 16)
    report.writeUInt32BE(this.packets >>> 0, 20)
    report.writeUInt32BE(this.octets >>> 0, 24)
    this.send(this.srtp.protectRtcp(report))
  }

  send (packet) {
    if (this.stopped) {
      return
    }
    this.socket.send(packet, this.port, this.address, (error) => {
      if (error) {
        this.onError(error)
      }
    })
  }
}

module.exports = { StillStream, streamSize, idrIntervalMs, rtpPayloads }
