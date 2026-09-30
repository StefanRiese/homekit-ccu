'use strict'

// The live video of a doorbell without camera: its still image as H.264 (I_PCM IDR frame and
// skipped P frames) over SRTP, made in JavaScript without ffmpeg.

const path = require('path')
const crypto = require('crypto')
const expect = require('expect.js')
const camera = path.join(__dirname, '..', 'lib', 'services', 'camera')
const { encodeStill, skipFrame, frameGeometry, nalUnit, BitWriter } = require(path.join(camera, 'h264Still.js'))
const { SrtpSender, deriveKey, counter } = require(path.join(camera, 'srtp.js'))
const { StillStream, streamSize, idrIntervalMs, rtpPayloads } = require(path.join(camera, 'StillStream.js'))
const { StillImageDelegate } = require(path.join(camera, 'stillDoorbell.js'))
const { bindUdpSocket } = require(path.join(camera, 'udpPort.js'))
const { StillImage } = require(path.join(__dirname, '..', 'lib', 'util', 'doorbellImage.js'))

const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
const hex = (value) => Buffer.from(value, 'hex')

// reads Exp-Golomb and plain bits of an RBSP, to check what the encoder wrote
class BitReader {
  constructor (buffer) {
    this.buffer = buffer
    this.position = 0
  }

  u (n) {
    let value = 0
    for (let i = 0; i < n; i++) {
      value = value * 2 + ((this.buffer[this.position >> 3] >> (7 - (this.position & 7))) & 1)
      this.position++
    }
    return value
  }

  ue () {
    let zeros = 0
    while (this.u(1) === 0) {
      zeros++
    }
    return 2 ** zeros - 1 + this.u(zeros)
  }
}

// the RBSP of a NAL unit: without the header and the emulation prevention bytes
function rbsp (nal) {
  const out = []
  let zeros = 0
  for (const byte of nal.subarray(1)) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0
      continue
    }
    out.push(byte)
    zeros = byte === 0 ? zeros + 1 : 0
  }
  return Buffer.from(out)
}

function flat (width, height, [r, g, b]) {
  const rgba = Buffer.alloc(width * height * 4)
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = r
    rgba[i + 1] = g
    rgba[i + 2] = b
    rgba[i + 3] = 255
  }
  return rgba
}

// the receiving side of SRTP (RFC 3711), to check what the sender protected
function unprotectRtp (keyAndSalt, packet, rolloverCounter = 0) {
  const key = deriveKey(keyAndSalt.subarray(0, 16), keyAndSalt.subarray(16), 0, 16)
  const auth = deriveKey(keyAndSalt.subarray(0, 16), keyAndSalt.subarray(16), 1, 20)
  const salt = deriveKey(keyAndSalt.subarray(0, 16), keyAndSalt.subarray(16), 2, 14)
  const body = packet.subarray(0, packet.length - 10)
  const roc = Buffer.alloc(4)
  roc.writeUInt32BE(rolloverCounter)
  const tag = crypto.createHmac('sha1', auth).update(body).update(roc).digest().subarray(0, 10)
  expect(tag.equals(packet.subarray(packet.length - 10))).to.be(true)
  const index = rolloverCounter * 65536 + packet.readUInt16BE(2)
  const decipher = crypto.createDecipheriv('aes-128-ctr', key, counter(salt, packet.readUInt32BE(8), index))
  return { header: body.subarray(0, 12), payload: Buffer.concat([decipher.update(body.subarray(12)), decipher.final()]) }
}

describe('HomeKit-CCU live video of a still image', () => {
  describe('H.264', () => {
    it('writes Exp-Golomb codes', () => {
      const w = new BitWriter(1)
      w.ue(0)
      w.ue(1)
      w.ue(2)
      w.se(-1)
      w.se(1)
      w.u(3, 5)
      // 1 010 011 011 010 101, the stop bit and zeros
      expect(w.trailing().toString('hex')).to.be('a6d580')
    })

    it('inserts emulation prevention bytes, so no start code appears in a NAL unit', () => {
      expect(nalUnit(3, 7, Buffer.from([0, 0, 1, 0, 0, 0, 0, 0, 4]))).to.eql(Buffer.from([0x67, 0, 0, 3, 1, 0, 0, 3, 0, 0, 3, 0, 4]))
    })

    it('describes the size in the sequence parameter set, cropped to the pixels', () => {
      const { sps, pps } = encodeStill(flat(640, 360, [0, 0, 0]), 640, 360, 31)
      expect(sps[0]).to.be(0x67)
      expect(pps[0]).to.be(0x68)
      const r = new BitReader(rbsp(sps))
      expect([r.u(8), r.u(8), r.u(8)]).to.eql([66, 0xC0, 31])
      expect(r.ue()).to.be(0) // sps id
      expect(r.ue()).to.be(4) // log2_max_frame_num_minus4
      expect(r.ue()).to.be(0) // pic_order_cnt_type
      expect(r.ue()).to.be(4)
      expect(r.ue()).to.be(1) // max_num_ref_frames
      expect(r.u(1)).to.be(0)
      expect(r.ue() + 1).to.be(40)
      expect(r.ue() + 1).to.be(23)
      expect([r.u(1), r.u(1), r.u(1)]).to.eql([1, 1, 1])
      // cropping in units of 2 lines: 368 - 360 = 8 lines
      expect([r.ue(), r.ue(), r.ue(), r.ue()]).to.eql([0, 0, 0, 4])
    })

    it('carries the pixels as I_PCM macroblocks in the IDR frame', () => {
      const frame = encodeStill(flat(32, 16, [255, 255, 255]), 32, 16)
      expect(frame.mbCount).to.be(2)
      expect(frame.idr[0]).to.be(0x65)
      const data = rbsp(frame.idr)
      // white: luma 235, both chroma 128, 256 + 64 + 64 bytes per macroblock
      const block = Buffer.concat([Buffer.alloc(256, 235), Buffer.alloc(128, 128)])
      const first = data.indexOf(block)
      expect(first).to.be.greaterThan(0)
      expect(data.indexOf(block, first + block.length)).to.be.greaterThan(first)
    })

    it('repeats the picture with P frames that skip every macroblock and are no reference', () => {
      const p = skipFrame(frameGeometry(640, 360), 3)
      expect(p[0]).to.be(0x01)
      expect(p.length).to.be.lessThan(12)
      const r = new BitReader(rbsp(p))
      expect(r.ue()).to.be(0)
      expect(r.ue()).to.be(5) // P slice
      expect(r.ue()).to.be(0)
      expect(r.u(8)).to.be(1) // frame_num after the IDR
      expect(r.u(8)).to.be(6) // picture order count
    })

    it('refuses an odd size', () => {
      expect(() => frameGeometry(641, 360)).to.throwError(/even/)
    })
  })

  describe('SRTP', () => {
    // RFC 3711 B.3
    const masterKey = hex('E1F97A0D3E018BE0D64FA32C06DE4139')
    const masterSalt = hex('0EC675AD498AFEEBB6960B3AABE6')

    it('derives the session keys of RFC 3711', () => {
      expect(deriveKey(masterKey, masterSalt, 0, 16).toString('hex')).to.be('c61e7a93744f39ee10734afe3ff7a087')
      expect(deriveKey(masterKey, masterSalt, 2, 14).toString('hex')).to.be('30cbbc08863d8c85d49db34a9ae1')
      expect(deriveKey(masterKey, masterSalt, 1, 20).toString('hex')).to.be('cebe321f6ff7716b6fd4ab49af256a156d38baa4')
    })

    it('builds the counter of AES-CM of RFC 3711 B.2', () => {
      const salt = hex('F0F1F2F3F4F5F6F7F8F9FAFBFCFD')
      expect(counter(salt, 0, 0).toString('hex')).to.be('f0f1f2f3f4f5f6f7f8f9fafbfcfd0000')
      expect(counter(Buffer.alloc(14), 0x01020304, 0x0000AABBCCDD).toString('hex')).to.be('0000000001020304 0000aabbccdd0000'.replace(' ', ''))
    })

    it('encrypts and authenticates RTP, which the receiver decrypts', () => {
      const keyAndSalt = Buffer.concat([masterKey, masterSalt])
      const packet = Buffer.concat([hex('80e1123400000064deadbeef'), Buffer.from('payload of the packet')])
      const protectedPacket = new SrtpSender(keyAndSalt).protectRtp(packet, 1)
      expect(protectedPacket.length).to.be(packet.length + 10)
      expect(protectedPacket.subarray(12, packet.length).equals(packet.subarray(12))).to.be(false)
      const { header, payload } = unprotectRtp(keyAndSalt, protectedPacket, 1)
      expect(header.equals(packet.subarray(0, 12))).to.be(true)
      expect(payload.toString()).to.be('payload of the packet')
    })

    it('protects RTCP with the E flag and a growing index', () => {
      const sender = new SrtpSender(Buffer.concat([masterKey, masterSalt]))
      const report = Buffer.alloc(28)
      report[0] = 0x80
      report[1] = 200
      const first = sender.protectRtcp(report)
      const second = sender.protectRtcp(report)
      expect(first.length).to.be(28 + 4 + 10)
      expect(first.readUInt32BE(28)).to.be(0x80000000)
      expect(second.readUInt32BE(28)).to.be(0x80000001)
      expect(first.subarray(0, 8).equals(report.subarray(0, 8))).to.be(true)
    })

    it('needs a key of 16 and a salt of 14 bytes', () => {
      expect(() => new SrtpSender(Buffer.alloc(16))).to.throwError()
    })
  })

  describe('stream', () => {
    it('sends at most 640x480, even, and scales the size asked for', () => {
      expect(streamSize(1920, 1080)).to.eql({ width: 640, height: 360 })
      expect(streamSize(1280, 960)).to.eql({ width: 640, height: 480 })
      expect(streamSize(320, 240)).to.eql({ width: 320, height: 240 })
      expect(streamSize(480, 270)).to.eql({ width: 480, height: 270 })
    })

    it('sends the IDR frame again as the bit rate allows, every 2 to 20 s', () => {
      expect(idrIntervalMs(350000, 2000)).to.be(2000)
      expect(idrIntervalMs(350000, 299)).to.be(9365)
      expect(idrIntervalMs(350000, 50)).to.be(20000)
      expect(idrIntervalMs(350000, 0)).to.be(9334)
    })

    it('fragments a large NAL unit into FU-A packets that join to it again', () => {
      const nal = Buffer.concat([Buffer.from([0x65]), crypto.randomBytes(3000)])
      const payloads = rtpPayloads(nal, 1000)
      expect(payloads.length).to.be(4)
      expect(payloads.every(payload => payload.length <= 1000)).to.be(true)
      expect(payloads.map(payload => payload[1] & 0xC0)).to.eql([0x80, 0, 0, 0x40])
      expect(payloads[0][0]).to.be(0x60 | 28)
      const joined = Buffer.concat([Buffer.from([(payloads[0][0] & 0xE0) | (payloads[0][1] & 0x1F)]), ...payloads.map(payload => payload.subarray(2))])
      expect(joined.equals(nal)).to.be(true)
      expect(rtpPayloads(Buffer.from([0x67, 1, 2]), 1000)).to.eql([Buffer.from([0x67, 1, 2])])
    })

    it('sends an RTCP sender report once packets went out', () => {
      const sent = []
      const frame = encodeStill(flat(32, 32, [0, 0, 0]), 32, 32)
      const stream = new StillStream({ frame, socket: { send: (packet) => sent.push(packet) }, address: '127.0.0.1', port: 1, ssrc: 7, srtp: crypto.randomBytes(30), payloadType: 99 })
      stream.senderReport()
      expect(sent.length).to.be(0)
      stream.startedAt = Date.now()
      stream.nextIdrAt = 0
      stream.idrCount = 0
      stream.nextFrame()
      stream.sendQueued()
      stream.senderReport()
      const report = sent[sent.length - 1]
      expect(report[1]).to.be(200)
      expect(report.readUInt32BE(4)).to.be(7)
      stream.stop()
      stream.send(Buffer.alloc(1))
      expect(sent[sent.length - 1]).to.be(report)
    })
  })

  describe('delegate', () => {
    let receiver
    const key = crypto.randomBytes(16)
    const salt = crypto.randomBytes(14)
    const options = { liveVideo: true, bindReturnSocket: (version) => bindUdpSocket(version, 0), watchdogFloorSeconds: 0.05 }
    const frameOf = (width, height) => encodeStill(flat(width, height, [255, 255, 255]), width, height)
    const still = { snapshot: async () => Buffer.alloc(0), frame: async (width, height) => frameOf(width, height) }

    beforeEach(async () => {
      receiver = await bindUdpSocket('ipv4', 0)
    })

    afterEach(() => receiver.close())

    const prepare = (delegate, sessionID) => new Promise((resolve, reject) => delegate.prepareStream({
      sessionID,
      targetAddress: '127.0.0.1',
      addressVersion: 'ipv4',
      video: { port: receiver.address().port, srtp_key: key, srtp_salt: salt },
      audio: { port: 1, srtp_key: key, srtp_salt: salt }
    }, (error, response) => error ? reject(error) : resolve(response)))

    const start = (delegate, sessionID) => new Promise(resolve => delegate.handleStreamRequest({
      sessionID,
      type: 'start',
      video: { width: 320, height: 240, fps: 30, pt: 99, mtu: 600, max_bit_rate: 300, rtcp_interval: 0.01, level: 0 }
    }, resolve))

    it('streams SPS, PPS and the IDR frame, then skipped frames, over SRTP', async () => {
      const delegate = new StillImageDelegate(still, 'Door', log, options)
      const response = await prepare(delegate, 'a')
      expect(response.video.port).to.be.a('number')
      expect(response.audio.port).to.be.a('number')
      const packets = []
      const received = new Promise(resolve => receiver.on('message', (packet) => {
        if (packet[1] === 200) {
          return
        }
        packets.push(unprotectRtp(Buffer.concat([key, salt]), packet))
        // the first skipped frame follows the IDR frame
        if ((packets[packets.length - 1].payload[0] & 0x1F) === 1) {
          resolve()
        }
      }))
      await start(delegate, 'a')
      await received
      delegate.handleStreamRequest({ sessionID: 'a', type: 'stop' }, () => {})
      expect(delegate.sessions.size).to.be(0)
      const types = packets.map(({ payload }) => payload[0] & 0x1F)
      expect(types.slice(0, 3)).to.eql([7, 8, 28])
      // the IDR frame in FU-A fragments, joined again
      const frame = frameOf(320, 240)
      const fragments = packets.filter(({ payload }) => (payload[0] & 0x1F) === 28 && (payload[1] & 0x1F) === 5)
      const idr = Buffer.concat([Buffer.from([0x65]), ...fragments.slice(0, fragments.findIndex(({ payload }) => payload[1] & 0x40) + 1).map(({ payload }) => payload.subarray(2))])
      expect(idr.equals(frame.idr)).to.be(true)
      expect(types).to.contain(1)
      expect(packets.every(({ header }) => header[0] === 0x80 && (header[1] & 0x7F) === 99)).to.be(true)
      // the access unit ends with the marker bit
      const lastOfIdr = packets.findIndex(({ payload }) => (payload[0] & 0x1F) === 28 && (payload[1] & 0x40))
      expect(packets[lastOfIdr].header[1] & 0x80).to.be(0x80)
      expect(packets[1].header[1] & 0x80).to.be(0)
    })

    it('stops a session when the viewer stopped sending RTCP, only after it sent some', async () => {
      const delegate = new StillImageDelegate(still, 'Door', log, options)
      const stopped = []
      delegate.attachController({ forceStopStreamingSession: (sessionID) => stopped.push(sessionID) })
      const response = await prepare(delegate, 'b')
      await start(delegate, 'b')
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(stopped).to.eql([])
      const viewer = await bindUdpSocket('ipv4', 0)
      await new Promise(resolve => viewer.send(Buffer.from([0x80, 201, 0, 1]), response.video.port, '127.0.0.1', resolve))
      viewer.close()
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(stopped).to.eql(['b'])
      expect(delegate.sessions.size).to.be(0)
    })

    it('ends the session when the picture cannot be rendered', async () => {
      const failing = { snapshot: async () => Buffer.alloc(0), frame: async () => { throw new Error('boom') } }
      const delegate = new StillImageDelegate(failing, 'Door', log, options)
      const stopped = []
      delegate.attachController({ forceStopStreamingSession: (sessionID) => stopped.push(sessionID) })
      await prepare(delegate, 'c')
      await start(delegate, 'c')
      await new Promise(resolve => setImmediate(resolve))
      expect(stopped).to.eql(['c'])
    })

    it('refuses to start a session that was not prepared, keeps a reconfigured one', (done) => {
      const delegate = new StillImageDelegate(still, 'Door', log, options)
      delegate.handleStreamRequest({ sessionID: 'x', type: 'reconfigure', video: {} }, (error) => {
        expect(error).to.be(undefined)
        delegate.handleStreamRequest({ sessionID: 'x', type: 'start', video: { width: 320, height: 240 } }, (startError) => {
          expect(startError).to.be.an(Error)
          done()
        })
      })
    })

    it('reports a port that cannot be bound', (done) => {
      const failing = { liveVideo: true, bindReturnSocket: () => Promise.reject(new Error('taken')), bindUdpSocket: () => Promise.reject(new Error('none')) }
      new StillImageDelegate(still, 'Door', log, failing).prepareStream({ addressVersion: 'ipv4' }, (error) => {
        expect(error.message).to.be('none')
        done()
      })
    })

    it('stops all sessions on shutdown', async () => {
      const delegate = new StillImageDelegate(still, 'Door', log, options)
      await prepare(delegate, 'd')
      await start(delegate, 'd')
      delegate.shutdown()
      expect(delegate.sessions.size).to.be(0)
    })
  })

  it('renders the picture as H.264 in a worker thread, once per size', async () => {
    const image = new StillImage([], log, 'Door')
    const frame = await image.frame(64, 48, 31)
    expect(Buffer.isBuffer(frame.idr)).to.be(true)
    expect(frame.sps[0]).to.be(0x67)
    expect(await image.frame(64, 48, 31)).to.be(frame)
  })
})
