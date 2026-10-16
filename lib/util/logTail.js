'use strict'

/*
 * The end of the log file for the log view of the settings page, read from the end so the file
 * (which grows until it is rotated) is never read or sent whole. Only complete lines are sent:
 * a line still being written is sent once it ends, from the offset returned with the lines.
 * With `levels` only the lines of those levels are sent; the end of the log is then read further
 * back (at most `scanBytes`, 1 MB with every level) until there are `lines` of them, so the lines of a log full of debug
 * lines are found when debug is switched off in the view.
 */

const fs = require('fs')

const TAIL_LINES = 1000
const MAX_BYTES = 256 * 1024
const SCAN_BYTES = 4 * 1024 * 1024
// with every level: how far back for TAIL_LINES lines, when they are long
const SCAN_ALL_BYTES = 1024 * 1024
const LEVELS = ['error', 'warn', 'info', 'debug']

// as js/logformat.js of the page: "[10/2/2026, 8:07:38 AM] info - ..."; a line of the rc.d script
// has a time stamp but no level (info), a line without one belongs to the line before
const LEVEL = /^\[[^\]]*\] (error|warn|info|debug) - /
const STAMP = /^\[(\d{1,2}\/\d{1,2}\/\d{4},[^\]]*)\]/

function levelOf (line, previous) {
  const match = LEVEL.exec(line)
  if (match) {
    return match[1]
  }
  return STAMP.test(line) ? 'info' : previous
}

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
 * The complete lines of `data` (bytes from `start` of the file), the first one left out when the
 * read began in the middle of a line.
 * @returns {{lines: string[], begin: number, end: number}} begin and end in `data`; end -1 when
 *   there is no complete line
 */
function completeLines (data, cutFirst) {
  let begin = 0
  if (cutFirst) {
    const firstEnd = data.indexOf(0x0a)
    begin = (firstEnd === -1) ? data.length : firstEnd + 1
  }
  const lastEnd = data.lastIndexOf(0x0a)
  if (lastEnd < begin) {
    return { lines: [], begin, end: -1 }
  }
  const lines = data.subarray(begin, lastEnd).toString('utf8').replace(/\r/g, '').split('\n')
  return { lines, begin, end: lastEnd }
}

/** the lines with their levels, those of `wanted` (all without) */
function select (lines, wanted, previous) {
  const result = { lines: [], levels: [], last: previous }
  lines.forEach(line => {
    result.last = levelOf(line, result.last)
    if (!wanted || wanted.has(result.last)) {
      result.lines.push(line)
      result.levels.push(result.last)
    }
  })
  return result
}

// the lines of `wanted` levels (every line without) in a piece of the log that have a level (or
// a time stamp) of their own
const LINE_LEVEL = /^\[\d{1,2}\/\d{1,2}\/\d{4},[^\]]*\] (?:(error|warn|info|debug) - )?/gm
function countLevels (text, wanted) {
  if (!wanted) {
    return text.split('\n').length - 1
  }
  let count = 0
  for (const match of text.matchAll(LINE_LEVEL)) {
    if (wanted.has(match[1] || 'info')) {
      count++
    }
  }
  return count
}

const stampOf = (lines) => {
  for (const line of lines) {
    const match = STAMP.exec(line)
    if (match) {
      return match[1]
    }
  }
  return undefined
}

/**
 * Lines of the log since `offset` (a number the last call returned, with its `file` and `last`),
 * or the last `lines` lines without one.
 * @param {object} options
 *   levels: the levels to send (all without); last: the level of the last line of the call before
 * @returns {Promise<object>} { offset, file, last, lines, lineLevels, reset, skipped, since }
 *   offset, file and last: where the next call goes on; lineLevels: the level of each line;
 *   reset: the file was rotated or emptied since `offset` (the lines are the end of the new one);
 *   skipped: more was written than `maxBytes`, the lines before the ones sent are left out;
 *   since: the time stamp of the first line read, for the end of the log (how far back it goes)
 */
async function readLogTail (logFile, { offset, file, last, levels, lines = TAIL_LINES, maxBytes = MAX_BYTES, scanBytes = SCAN_BYTES } = {}) {
  const following = Number.isInteger(offset) && offset >= 0
  // an empty list (every level switched off) sends no line
  const wanted = (Array.isArray(levels) && levels.length < LEVELS.length) ? new Set(levels) : undefined
  const previous = LEVELS.includes(last) ? last : 'info'
  const empty = { offset: 0, file: 0, last: 'info', lines: [], lineLevels: [], skipped: false }
  let stat
  try {
    if (!logFile) {
      // not known yet: the main process sends it after its start
      throw Object.assign(new Error('no log file'), { code: 'ENOENT' })
    }
    stat = await fs.promises.stat(logFile)
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { ...empty, reset: following && offset > 0 }
    }
    throw e
  }
  const size = stat.size
  // a rotated file is another file (inode), an emptied one is shorter than where the last call ended
  const reset = following && ((offset > size) || (file !== undefined && file !== stat.ino))

  if (following && !reset) {
    // the lines written since the last call, at most maxBytes of them
    const start = Math.max(offset, size - maxBytes)
    const data = await readRange(logFile, start, size)
    const skipped = start > offset
    const found = completeLines(data, skipped)
    if (found.end === -1) {
      return { offset: start + found.begin, file: stat.ino, last: previous, lines: [], lineLevels: [], reset: false, skipped }
    }
    const chosen = select(found.lines, wanted, skipped ? 'info' : previous)
    return { offset: start + found.end + 1, file: stat.ino, last: chosen.last, lines: chosen.lines, lineLevels: chosen.levels, reset: false, skipped }
  }

  // the end of the log: maxBytes, read further back while the levels asked for are not enough
  const limit = Math.max(maxBytes, wanted ? scanBytes : Math.min(scanBytes, SCAN_ALL_BYTES))
  let start = Math.max(0, size - maxBytes)
  let data = await readRange(logFile, start, size)
  let found = completeLines(data, start > 0)
  let chosen = select(found.lines, wanted, 'info')
  // further back, a chunk at a time; only the lines with a level of their own are counted there
  // (the lines of a stack trace come with them), the whole is split into lines once at the end
  let count = chosen.lines.length
  const chunks = [data]
  while ((count < lines) && (start > 0) && (size - start < limit)) {
    const next = Math.max(0, size - limit, start - maxBytes)
    const chunk = await readRange(logFile, next, start)
    chunks.unshift(chunk)
    count += countLevels(chunk.toString('utf8'), wanted)
    start = next
  }
  if (chunks.length > 1) {
    data = Buffer.concat(chunks)
    found = completeLines(data, start > 0)
    chosen = select(found.lines, wanted, 'info')
  }
  if (found.end === -1) {
    return { offset: start + found.begin, file: stat.ino, last: 'info', lines: [], lineLevels: [], reset, skipped: false }
  }
  return {
    offset: start + found.end + 1,
    file: stat.ino,
    last: chosen.last,
    lines: chosen.lines.slice(-lines),
    lineLevels: chosen.levels.slice(-lines),
    reset,
    skipped: false,
    since: stampOf(found.lines)
  }
}

module.exports = { readLogTail, levelOf, TAIL_LINES, MAX_BYTES, SCAN_BYTES, LEVELS }
