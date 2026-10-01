'use strict'

/*
 * The .pstore file of an accessory keeps a few values over restarts (last activation, last
 * reset, ...). It is read when the accessory is created: a file that is empty or cut off (power
 * loss or a full disk while it was written) must not keep the device from being added, and a
 * file is written whole or not at all.
 */

const fs = require('fs')
const path = require('path')

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * @param {string} file
 * @param {{warn: function}} log
 * @returns {object} the stored values; {} when there is no file or it is unusable (then it is
 *   kept next to it as <file>.corrupt, replacing an older one, and the next save starts a new one)
 */
function loadStore (file, log) {
  if (!fs.existsSync(file)) {
    return {}
  }
  let reason
  try {
    const values = JSON.parse(fs.readFileSync(file).toString())
    if (isPlainObject(values)) {
      return values
    }
    reason = 'it does not hold stored values'
  } catch (e) {
    reason = e.message
  }
  try {
    fs.renameSync(file, file + '.corrupt')
  } catch (e) {
    reason += ' (and it could not be put aside: ' + e.message + ')'
  }
  log.warn('[Accessory] ignoring the stored values in %s, starting without: %s', path.basename(file), reason)
  return {}
}

/** Writes the values to a temporary file and renames it, so the file is never half written. */
function saveStore (file, values) {
  const temporary = file + '.tmp'
  fs.writeFileSync(temporary, JSON.stringify(values))
  fs.renameSync(temporary, file)
}

module.exports = { loadStore, saveStore }
