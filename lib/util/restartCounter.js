'use strict'

/*
 * restartCounter.json counts the starts since the add-on was last stable for an hour; at 5 the
 * monitoring is switched off, because something is seriously wrong. The file is written at every
 * start, so a power loss can leave it empty or cut off: that must not keep the add-on from starting.
 */

const fs = require('fs')
const path = require('path')
const { saveStore } = require(path.join(__dirname, 'persistentStore.js'))

/**
 * @param {string} file
 * @param {{warn: function}} log
 * @returns {number} the counted starts; 0 without a file or when it holds no count
 */
function readRestartCount (file, log) {
  if (!fs.existsSync(file)) {
    return 0
  }
  let reason
  try {
    const count = JSON.parse(fs.readFileSync(file).toString())
    if (Number.isInteger(count) && count >= 0) {
      return count
    }
    reason = 'it does not hold a count'
  } catch (e) {
    reason = e.message
  }
  log.warn('[Server] ignoring the restart counter in %s, counting from 0: %s', path.basename(file), reason)
  return 0
}

/** Saves the count (whole or not at all); a failure is logged, the start goes on. */
function writeRestartCount (file, count, log) {
  try {
    saveStore(file, count)
  } catch (e) {
    log.warn('[Server] unable to save the restart counter in %s: %s', path.basename(file), e.message)
  }
}

module.exports = { readRestartCount, writeRestartCount }
