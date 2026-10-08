'use strict'

const util = require('util')
const fs = require('fs')

let DEBUG_ENABLED = false
let LOGFILE
// whether this process rotates the log (the main process; the configuration service shares its file)
let ROTATING = false
const LIMITS = {
  // the log is appended to (the installer writes into the same file); a file larger than this
  // is moved to <file>.1 so it cannot grow forever on the CCU's small /var/log: at the start,
  // and while running (debug writes several MB an hour)
  rotateSize: 2 * 1024 * 1024,
  // how often a writer looks at its file while it writes: rotated (by the main process) or
  // removed, it opens the new file, so the other process does not go on writing into <file>.1
  checkMs: 5000
}

/** moves a log larger than the limit to <file>.1; true when it did */
function rotateIfLarge (logFile, stat = fs.statSync(logFile, { throwIfNoEntry: false })) {
  try {
    if (stat && stat.size > LIMITS.rotateSize) {
      fs.renameSync(logFile, logFile + '.1') // replaces an older .1
      return true
    }
  } catch (e) {
    console.error('unable to rotate %s: %s', logFile, e.message)
  }
  return false
}

// ANSI styling only for terminals that support it (honours NO_COLOR/FORCE_COLOR via hasColors);
// the stream is checked here because util.styleText only validates it from Node.js 22.13 on
function paint (format, text, stream) {
  if (stream.isTTY && typeof stream.hasColors === 'function' && stream.hasColors()) {
    return util.styleText(format, text, { validateStream: false })
  }
  return text
}

/**
 * Logger class
 */

class Logger {
  constructor (prefix) {
    this.prefix = prefix
  }

  setDebugEnabled (enabled) {
    DEBUG_ENABLED = enabled
  }

  isDebugEnabled () {
    return DEBUG_ENABLED
  }

  // rotate: false for the configuration service, which shares the file of the main process
  setLogFile (logFile, rotate = true) {
    LOGFILE = logFile
    ROTATING = Boolean(logFile && rotate)
    if (logFile) {
      if (rotate) rotateIfLarge(logFile)
      process.env.UIX_LOGFILE = logFile
    } else {
      delete process.env.UIX_LOGFILE
    }
  }

  getLogFile () {
    return LOGFILE
  }

  _getWriter () {
    if (LOGFILE) {
      if (this.writer && ((this.writerFile !== LOGFILE) || this._isStale())) {
        this.writer.end()
        this.writer = undefined
      }
      if (!this.writer) {
        // only root reads the log (it can hold device names and the addresses of the home)
        let ino
        try {
          fs.closeSync(fs.openSync(LOGFILE, 'a', 0o600))
          fs.chmodSync(LOGFILE, 0o600)
          ino = fs.statSync(LOGFILE).ino
        } catch (e) {
          // not ours; the stream reports what fails
        }
        this.writer = fs.createWriteStream(LOGFILE, { flags: 'a', mode: 0o600 })
        this.writerFile = LOGFILE
        this.writerIno = ino
        this.checkedAt = Date.now()
      }
      return this.writer
    }
  }

  // every LIMITS.checkMs: whether the writer has to open the file again, because this process
  // rotated it now, or another one did (another inode), or it was removed
  _isStale () {
    const now = Date.now()
    if (now - this.checkedAt < LIMITS.checkMs) {
      return false
    }
    this.checkedAt = now
    let stat
    try {
      stat = fs.statSync(LOGFILE, { throwIfNoEntry: false })
    } catch (e) {
      return false
    }
    if (!stat) {
      return true
    }
    if (ROTATING && rotateIfLarge(LOGFILE, stat)) {
      return true
    }
    return (this.writerIno !== undefined) && (stat.ino !== this.writerIno)
  }

  close () {
    if (this.writer) {
      this.writer.end()
    }
  }

  debug (msg) {
    if (DEBUG_ENABLED) {
      this.log.apply(this, ['debug'].concat(Array.prototype.slice.call(arguments)))
    }
  }

  info (msg) {
    this.log.apply(this, ['info'].concat(Array.prototype.slice.call(arguments)))
  }

  warn (msg) {
    this.log.apply(this, ['warn'].concat(Array.prototype.slice.call(arguments)))
  }

  error (msg) {
    this.log.apply(this, ['error'].concat(Array.prototype.slice.call(arguments)))
  }

  log (level, msg) {
    const rawMsg = util.format.apply(util, Array.prototype.slice.call(arguments, 1))

    const toStderr = (level === 'warn') || (level === 'error')
    const func = toStderr ? console.error : console.log
    const stream = toStderr ? process.stderr : process.stdout

    if (level === 'debug') {
      msg = paint('gray', rawMsg, stream)
    } else if (level === 'warn') {
      msg = paint('yellow', rawMsg, stream)
    } else if (level === 'error') {
      msg = paint(['bold', 'red'], rawMsg, stream)
    } else {
      msg = rawMsg
    }

    // prepend prefix if applicable
    if (this.prefix) {
      msg = paint('cyan', '[' + this.prefix + ']', stream) + ' ' + msg
    }

    // prepend timestamp
    const date = new Date()
    msg = '[' + date.toLocaleString() + ']' + ' ' + msg
    try {
      const writer = this._getWriter()
      if (writer) {
        let lmsg = rawMsg
        if (this.prefix) {
          lmsg = '[' + this.prefix + '] ' + lmsg
        }
        lmsg = '[' + date.toLocaleString() + '] ' + level + ' - ' + lmsg
        if (writer.writable) {
          writer.write(lmsg + '\n')
        }
      }
    } catch (e) { }
    func(msg)
  }
}

// a switch handed to a child process: process.env only holds text, and "false" is truthy
function isFlagSet (value) {
  return (value === true) || (value === 'true')
}

module.exports = Logger
module.exports.isFlagSet = isFlagSet
// for the tests: the size and the interval of the rotation
module.exports.LIMITS = LIMITS
