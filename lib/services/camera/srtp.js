'use strict'

/*
 * SRTP and SRTCP of the sending side (RFC 3711) with the crypto suite HomeKit asks for,
 * AES_CM_128_HMAC_SHA1_80, on Node's crypto: AES-128 in counter mode for the payload, an
 * HMAC-SHA1 tag of 80 bits. The key derivation rate is 0, so the session keys are derived once.
 */

const crypto = require('crypto')

const TAG_BYTES = 10
const RTP_HEADER_BYTES = 12
const RTCP_HEADER_BYTES = 8

// labels of the key derivation (4.3.1)
const LABEL = { rtpKey: 0, rtpAuth: 1, rtpSalt: 2, rtcpKey: 3, rtcpAuth: 4, rtcpSalt: 5 }

/** a session key of the master key and salt (4.3.1, 4.3.3: AES-CM as PRF) */
function deriveKey (masterKey, masterSalt, label, length) {
  const iv = Buffer.alloc(16)
  masterSalt.copy(iv, 0, 0, 14)
  iv[7] ^= label
  const cipher = crypto.createCipheriv('aes-128-ctr', masterKey, iv)
  return Buffer.concat([cipher.update(Buffer.alloc(length)), cipher.final()])
}

/** the counter of AES-CM (4.1.1): salt * 2^16 XOR SSRC * 2^64 XOR index * 2^16 */
function counter (salt, ssrc, index) {
  const iv = Buffer.alloc(16)
  salt.copy(iv, 0, 0, 14)
  iv.writeUInt32BE((iv.readUInt32BE(4) ^ ssrc) >>> 0, 4)
  // the index has 48 bits: the upper 16 in bytes 8-9, the lower 32 in bytes 10-13
  iv.writeUInt16BE(iv.readUInt16BE(8) ^ Math.floor(index / 2 ** 32), 8)
  iv.writeUInt32BE((iv.readUInt32BE(10) ^ (index % 2 ** 32)) >>> 0, 10)
  return iv
}

function encrypt (key, iv, data) {
  const cipher = crypto.createCipheriv('aes-128-ctr', key, iv)
  return Buffer.concat([cipher.update(data), cipher.final()])
}

function tag (authKey, ...parts) {
  const hmac = crypto.createHmac('sha1', authKey)
  parts.forEach(part => hmac.update(part))
  return hmac.digest().subarray(0, TAG_BYTES)
}

/**
 * Protects the RTP and RTCP packets of one stream (one SSRC).
 * @param {Buffer} keyAndSalt the 16 bytes master key and 14 bytes master salt, as HomeKit sends them
 */
class SrtpSender {
  constructor (keyAndSalt) {
    if (!Buffer.isBuffer(keyAndSalt) || keyAndSalt.length !== 30) {
      throw new Error('SRTP needs a master key of 16 and a master salt of 14 bytes')
    }
    const masterKey = keyAndSalt.subarray(0, 16)
    const masterSalt = keyAndSalt.subarray(16)
    const key = (label, length) => deriveKey(masterKey, masterSalt, label, length)
    this.rtp = { key: key(LABEL.rtpKey, 16), auth: key(LABEL.rtpAuth, 20), salt: key(LABEL.rtpSalt, 14) }
    this.rtcp = { key: key(LABEL.rtcpKey, 16), auth: key(LABEL.rtcpAuth, 20), salt: key(LABEL.rtcpSalt, 14) }
    this.rtcpIndex = 0
  }

  /**
   * @param {Buffer} packet an RTP packet with a 12 byte header (no CSRC, no extension)
   * @param {number} rolloverCounter how often the sequence number wrapped (3.3.1)
   * @returns {Buffer} the SRTP packet
   */
  protectRtp (packet, rolloverCounter) {
    const ssrc = packet.readUInt32BE(8)
    const index = rolloverCounter * 65536 + packet.readUInt16BE(2)
    const header = packet.subarray(0, RTP_HEADER_BYTES)
    const payload = encrypt(this.rtp.key, counter(this.rtp.salt, ssrc, index), packet.subarray(RTP_HEADER_BYTES))
    const roc = Buffer.alloc(4)
    roc.writeUInt32BE(rolloverCounter >>> 0)
    return Buffer.concat([header, payload, tag(this.rtp.auth, header, payload, roc)])
  }

  /**
   * @param {Buffer} packet a compound RTCP packet
   * @returns {Buffer} the SRTCP packet (encrypted, E flag and index, tag)
   */
  protectRtcp (packet) {
    const ssrc = packet.readUInt32BE(4)
    const index = this.rtcpIndex
    this.rtcpIndex = (this.rtcpIndex + 1) % 2 ** 31
    const header = packet.subarray(0, RTCP_HEADER_BYTES)
    const payload = encrypt(this.rtcp.key, counter(this.rtcp.salt, ssrc, index), packet.subarray(RTCP_HEADER_BYTES))
    const eIndex = Buffer.alloc(4)
    eIndex.writeUInt32BE((0x80000000 | index) >>> 0)
    return Buffer.concat([header, payload, eIndex, tag(this.rtcp.auth, header, payload, eIndex)])
  }
}

module.exports = { SrtpSender, deriveKey, counter }
