'use strict'

/*
 * H.264 of a still image, in pure JavaScript: the CCU has no ffmpeg. Apple Home shows live video
 * only as an H.264 stream; a doorbell without camera sends its picture as one: an IDR frame whose
 * macroblocks carry the pixels as they are (I_PCM, no transform, no prediction), followed by P
 * frames that skip every macroblock (a few bytes each, "nothing changed"). Constrained Baseline
 * profile (7.3 of the H.264 standard): CAVLC, no B frames, the P frames are no reference, so a
 * lost one never breaks the next.
 */

const PROFILE_BASELINE = 66
// constraint_set0 and constraint_set1: Constrained Baseline, which a Main profile decoder reads
const CONSTRAINTS = 0xC0
const LOG2_MAX_FRAME_NUM = 8
const LOG2_MAX_POC_LSB = 8
// mb_type of I_PCM in an I slice (table 7-11)
const MB_TYPE_I_PCM = 25
const SLICE_P = 5
const SLICE_I = 7
const NAL_SLICE = 1
const NAL_IDR = 5
const NAL_SPS = 7
const NAL_PPS = 8

/** writes the bits of a raw byte sequence payload (RBSP), 7.2 */
class BitWriter {
  constructor (capacity = 64) {
    this.buffer = Buffer.alloc(capacity)
    this.length = 0
    this.current = 0
    this.bits = 0
  }

  reserve (bytes) {
    if (this.length + bytes > this.buffer.length) {
      const grown = Buffer.alloc(Math.max(2 * this.buffer.length, this.length + bytes))
      this.buffer.copy(grown, 0, 0, this.length)
      this.buffer = grown
    }
  }

  bit (value) {
    this.current = (this.current << 1) | (value & 1)
    if (++this.bits === 8) {
      this.reserve(1)
      this.buffer[this.length++] = this.current
      this.current = 0
      this.bits = 0
    }
  }

  /** u(n): n bits, most significant first */
  u (n, value) {
    for (let i = n - 1; i >= 0; i--) {
      this.bit(Math.floor(value / 2 ** i))
    }
  }

  /** ue(v): Exp-Golomb (9.1) */
  ue (value) {
    const code = value + 1
    const length = Math.floor(Math.log2(code)) + 1
    this.u(length - 1, 0)
    this.u(length, code)
  }

  /** se(v): signed Exp-Golomb (9.1.1) */
  se (value) {
    this.ue(value <= 0 ? -2 * value : 2 * value - 1)
  }

  align () {
    while (this.bits !== 0) {
      this.bit(0)
    }
  }

  /** whole bytes, at a byte boundary */
  bytes (source, start, end) {
    this.reserve(end - start)
    source.copy(this.buffer, this.length, start, end)
    this.length += end - start
  }

  /** rbsp_trailing_bits (7.3.2.11) */
  trailing () {
    this.bit(1)
    this.align()
    return this.buffer.subarray(0, this.length)
  }
}

/**
 * A NAL unit (7.3.1) of an RBSP: the header byte and the payload with an emulation prevention
 * byte 3 after two zeros that a byte of 0 to 3 follows, so no start code appears inside.
 */
function nalUnit (refIdc, type, rbsp) {
  const out = Buffer.alloc(1 + rbsp.length + Math.ceil(rbsp.length / 2))
  out[0] = (refIdc << 5) | type
  let length = 1
  let zeros = 0
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 3) {
      out[length++] = 3
      zeros = 0
    }
    out[length++] = byte
    zeros = byte === 0 ? zeros + 1 : 0
  }
  return out.subarray(0, length)
}

/** macroblocks of a frame of this size; width and height must be even */
function frameGeometry (width, height) {
  if (!(width > 0 && height > 0) || (width % 2) || (height % 2)) {
    throw new Error(`the frame size must be even, not ${width}x${height}`)
  }
  const mbWidth = Math.ceil(width / 16)
  const mbHeight = Math.ceil(height / 16)
  return { width, height, mbWidth, mbHeight, mbCount: mbWidth * mbHeight }
}

/**
 * The sequence parameter set (7.3.2.1) with the cropping of a size that is no multiple of 16
 * and VUI that tells the decoder to show every frame at once (no reordering).
 */
function sequenceParameterSet (geometry, levelIdc) {
  const w = new BitWriter()
  w.u(8, PROFILE_BASELINE)
  w.u(8, CONSTRAINTS)
  w.u(8, levelIdc)
  w.ue(0) // seq_parameter_set_id
  w.ue(LOG2_MAX_FRAME_NUM - 4)
  w.ue(0) // pic_order_cnt_type 0: every slice carries its order
  w.ue(LOG2_MAX_POC_LSB - 4)
  w.ue(1) // max_num_ref_frames
  w.u(1, 0) // gaps_in_frame_num_value_allowed_flag
  w.ue(geometry.mbWidth - 1)
  w.ue(geometry.mbHeight - 1)
  w.u(1, 1) // frame_mbs_only_flag
  w.u(1, 1) // direct_8x8_inference_flag
  const cropRight = (geometry.mbWidth * 16 - geometry.width) / 2
  const cropBottom = (geometry.mbHeight * 16 - geometry.height) / 2
  const cropping = cropRight > 0 || cropBottom > 0
  w.u(1, cropping ? 1 : 0)
  if (cropping) {
    // in units of 2 pixels for 4:2:0 (7.4.2.1.1)
    w.ue(0)
    w.ue(cropRight)
    w.ue(0)
    w.ue(cropBottom)
  }
  w.u(1, 1) // vui_parameters_present_flag (E.1.1)
  w.u(1, 0) // aspect_ratio_info_present_flag
  w.u(1, 0) // overscan_info_present_flag
  w.u(1, 0) // video_signal_type_present_flag
  w.u(1, 0) // chroma_loc_info_present_flag
  w.u(1, 0) // timing_info_present_flag
  w.u(1, 0) // nal_hrd_parameters_present_flag
  w.u(1, 0) // vcl_hrd_parameters_present_flag
  w.u(1, 0) // pic_struct_present_flag
  w.u(1, 1) // bitstream_restriction_flag
  w.u(1, 1) // motion_vectors_over_pic_boundaries_flag
  w.ue(0) // max_bytes_per_pic_denom
  w.ue(0) // max_bits_per_mb_denom
  w.ue(16) // log2_max_mv_length_horizontal
  w.ue(16) // log2_max_mv_length_vertical
  w.ue(0) // max_num_reorder_frames
  w.ue(1) // max_dec_frame_buffering
  return nalUnit(3, NAL_SPS, w.trailing())
}

/** the picture parameter set (7.3.2.2): CAVLC, deblocking switched off by the slices */
function pictureParameterSet () {
  const w = new BitWriter()
  w.ue(0) // pic_parameter_set_id
  w.ue(0) // seq_parameter_set_id
  w.u(1, 0) // entropy_coding_mode_flag: CAVLC
  w.u(1, 0) // bottom_field_pic_order_in_frame_present_flag
  w.ue(0) // num_slice_groups_minus1
  w.ue(0) // num_ref_idx_l0_default_active_minus1
  w.ue(0) // num_ref_idx_l1_default_active_minus1
  w.u(1, 0) // weighted_pred_flag
  w.u(2, 0) // weighted_bipred_idc
  w.se(0) // pic_init_qp_minus26
  w.se(0) // pic_init_qs_minus26
  w.se(0) // chroma_qp_index_offset
  w.u(1, 1) // deblocking_filter_control_present_flag
  w.u(1, 0) // constrained_intra_pred_flag
  w.u(1, 0) // redundant_pic_cnt_present_flag
  return nalUnit(3, NAL_PPS, w.trailing())
}

/**
 * The picture in YCbCr 4:2:0 (BT.601, limited range), padded to whole macroblocks by repeating
 * the last column and row.
 * @param {Buffer|Uint8Array} rgba width * height * 4 bytes
 * @returns {{y: Buffer, cb: Buffer, cr: Buffer, stride: number}} planes of the padded size
 */
function toYCbCr (rgba, geometry) {
  const { width, height, mbWidth, mbHeight } = geometry
  const stride = mbWidth * 16
  const rows = mbHeight * 16
  const y = Buffer.alloc(stride * rows)
  const cb = Buffer.alloc(stride * rows / 4)
  const cr = Buffer.alloc(stride * rows / 4)
  const at = (px, py) => (Math.min(py, height - 1) * width + Math.min(px, width - 1)) * 4
  for (let py = 0; py < rows; py++) {
    for (let px = 0; px < stride; px++) {
      const i = at(px, py)
      y[py * stride + px] = ((66 * rgba[i] + 129 * rgba[i + 1] + 25 * rgba[i + 2] + 128) >> 8) + 16
    }
  }
  for (let py = 0; py < rows / 2; py++) {
    for (let px = 0; px < stride / 2; px++) {
      let r = 0
      let g = 0
      let b = 0
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const i = at(2 * px + dx, 2 * py + dy)
        r += rgba[i]
        g += rgba[i + 1]
        b += rgba[i + 2]
      }
      // the sums of four pixels: the average is folded into the shift
      cb[py * stride / 2 + px] = ((-38 * r - 74 * g + 112 * b + 512) >> 10) + 128
      cr[py * stride / 2 + px] = ((112 * r - 94 * g - 18 * b + 512) >> 10) + 128
    }
  }
  return { y, cb, cr, stride }
}

/** the IDR slice (7.3.3, 7.3.4, 7.3.5): every macroblock I_PCM */
function idrSlice (planes, geometry) {
  const { mbWidth, mbHeight, mbCount } = geometry
  const w = new BitWriter(mbCount * 386 + 32)
  w.ue(0) // first_mb_in_slice
  w.ue(SLICE_I)
  w.ue(0) // pic_parameter_set_id
  w.u(LOG2_MAX_FRAME_NUM, 0) // frame_num
  // idr_pic_id: only two IDR frames in a row need different ones, the stream has P frames between
  w.ue(0)
  w.u(LOG2_MAX_POC_LSB, 0) // pic_order_cnt_lsb
  w.u(1, 0) // no_output_of_prior_pics_flag
  w.u(1, 0) // long_term_reference_flag
  w.se(0) // slice_qp_delta
  w.ue(1) // disable_deblocking_filter_idc: PCM needs no filter
  const { y, cb, cr, stride } = planes
  const chromaStride = stride / 2
  for (let mby = 0; mby < mbHeight; mby++) {
    for (let mbx = 0; mbx < mbWidth; mbx++) {
      w.ue(MB_TYPE_I_PCM)
      w.align() // pcm_alignment_zero_bit
      for (let row = 0; row < 16; row++) {
        const start = (mby * 16 + row) * stride + mbx * 16
        w.bytes(y, start, start + 16)
      }
      for (const plane of [cb, cr]) {
        for (let row = 0; row < 8; row++) {
          const start = (mby * 8 + row) * chromaStride + mbx * 8
          w.bytes(plane, start, start + 8)
        }
      }
    }
  }
  return nalUnit(3, NAL_IDR, w.trailing())
}

/**
 * A P frame that repeats the IDR frame: all macroblocks skipped. It is no reference picture, so
 * frame_num stays 1 after the IDR (7.4.3) and only the picture order count grows.
 * @param {number} index frames since the IDR, 1 for the first P frame
 */
function skipFrame (geometry, index) {
  const w = new BitWriter()
  w.ue(0) // first_mb_in_slice
  w.ue(SLICE_P)
  w.ue(0) // pic_parameter_set_id
  w.u(LOG2_MAX_FRAME_NUM, 1) // frame_num
  w.u(LOG2_MAX_POC_LSB, (2 * index) % (2 ** LOG2_MAX_POC_LSB))
  w.u(1, 0) // num_ref_idx_active_override_flag
  w.u(1, 0) // ref_pic_list_modification_flag_l0
  w.se(0) // slice_qp_delta
  w.ue(1) // disable_deblocking_filter_idc
  w.ue(geometry.mbCount) // mb_skip_run: every macroblock
  return nalUnit(0, NAL_SLICE, w.trailing())
}

/**
 * The still picture as H.264.
 * @param {Buffer|Uint8Array} rgba width * height * 4 bytes
 * @param {number} width even
 * @param {number} height even
 * @param {number} levelIdc level_idc of the stream (31 for level 3.1)
 * @returns {{sps: Buffer, pps: Buffer, idr: Buffer, width: number, height: number, mbCount: number}}
 */
function encodeStill (rgba, width, height, levelIdc = 31) {
  const geometry = frameGeometry(width, height)
  const planes = toYCbCr(rgba, geometry)
  return {
    sps: sequenceParameterSet(geometry, levelIdc),
    pps: pictureParameterSet(),
    idr: idrSlice(planes, geometry),
    width,
    height,
    mbCount: geometry.mbCount
  }
}

module.exports = { encodeStill, skipFrame, frameGeometry, nalUnit, BitWriter, toYCbCr }
