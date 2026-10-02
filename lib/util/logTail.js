'use strict'

/*
 * The end of the log file for the log view of the settings page, read from the end so the file
 * (which grows until it is rotated) is never read or sent whole. Only complete lines are sent:
 * a line still being written is sent once it ends, from the offset returned with the lines.
 */

const fs = require('fs')

const TAIL_LINES = 500
const MAX_BYTES = 256 * 1024

/** bytes start..end of the file */
async function readRange (file, start, end) {
  const handle = await fs.promises.open(file, 'r')
  try {
    const buffer = Buffer.alloc(end - start)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * Lines of the log since `offset` (a number the last call returned, with the `file` it returned),
 * or the last `lines` lines without one, at most `maxBytes` of the file.
 * @returns {Promise<{offset: number, file: number, lines: string[], reset: boolean, skipped: boolean}>}
 *   offset and file: where the next call goes on; reset: the file was rotated or emptied since
 *   `offset` (the lines are the end of the new file); skipped: more was written than `maxBytes`,
 *   the lines before the ones sent are left out
 */
async function readLogTail (logFile, { offset, file, lines = TAIL_LINES, maxBytes = MAX_BYTES } = {}) {
  const following = Number.isInteger(offset) && offset >= 0
  let stat
  try {
    if (!logFile) {
      // not known yet: the main process sends it after its start
      throw Object.assign(new Error('no log file'), { code: 'ENOENT' })
    }
    stat = await fs.promises.stat(logFile)
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { offset: 0, file: 0, lines: [], reset: following && offset > 0, skipped: false }
    }
    throw e
  }
  const size = stat.size
  // a rotated file is another file (inode), an emptied one is shorter than where the last call ended
  const reset = following && ((offset > size) || (file !== undefined && file !== stat.ino))
  const from = (following && !reset) ? offset : Math.max(0, size - maxBytes)
  const start = Math.max(from, size - maxBytes)
  const data = await readRange(logFile, start, size)

  let begin = 0
  // a read that starts in the middle of a line leaves out that line
  if ((start > 0) && (start > from || !following || reset)) {
    const firstEnd = data.indexOf(0x0a)
    begin = (firstEnd === -1) ? data.length : firstEnd + 1
  }
  const lastEnd = data.lastIndexOf(0x0a)
  const skipped = start > from
  if (lastEnd < begin) {
    // no complete line yet: the next call starts at the line that is being written
    return { offset: start + begin, file: stat.ino, lines: [], reset, skipped }
  }
  let result = data.subarray(begin, lastEnd).toString('utf8').replace(/\r/g, '').split('\n')
  if (!following || reset) {
    result = result.slice(-lines)
  }
  return { offset: start + lastEnd + 1, file: stat.ino, lines: result, reset, skipped }
}

module.exports = { readLogTail, TAIL_LINES, MAX_BYTES }
