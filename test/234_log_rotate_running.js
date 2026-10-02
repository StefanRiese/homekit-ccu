'use strict'

// The log was rotated (moved to .1 when larger than 2 MB) only when the add-on started; with
// debug on it grew several MB an hour until the next start. The main process now rotates it
// while running too, and every writer (also the one of the configuration service, which shares
// the file) opens the new file, instead of going on writing into the rotated one.

const path = require('path')
const os = require('os')
const fs = require('fs')
const { once } = require('events')
const expect = require('expect.js')
const Logger = require(path.join(__dirname, '..', 'lib', 'logger.js'))

describe('HomeKit-CCU log rotated while running', () => {
  let scratch, file, savedEnv, savedLimits, loggers
  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hkccu-234-logger-'))
    file = path.join(scratch, 'homekit-ccu.log')
    savedEnv = process.env.UIX_LOGFILE
    savedLimits = { ...Logger.LIMITS }
    // a small log, checked at every line
    Object.assign(Logger.LIMITS, { rotateSize: 2000, checkMs: 0 })
    loggers = []
  })
  afterEach(() => {
    Object.assign(Logger.LIMITS, savedLimits)
    new Logger().setLogFile(undefined)
    if (savedEnv === undefined) {
      delete process.env.UIX_LOGFILE
    } else {
      process.env.UIX_LOGFILE = savedEnv
    }
    fs.rmSync(scratch, { recursive: true, force: true })
  })

  const quiet = (fn) => {
    const { log, error } = console
    console.log = () => {}
    console.error = () => {}
    try { fn() } finally { Object.assign(console, { log, error }) }
  }
  const logger = (prefix) => {
    const log = new Logger(prefix)
    loggers.push(log)
    return log
  }
  // writes and lets the streams write
  const write = async (log, text) => {
    quiet(() => log.info(text))
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  const closeAll = async () => {
    for (const log of loggers) {
      if (log.writer && !log.writer.closed) {
        log.close()
        await once(log.writer, 'close')
      }
    }
  }
  const read = (name) => fs.existsSync(name) ? fs.readFileSync(name, 'utf8') : ''

  it('rotates a log that grows past the limit while running', async () => {
    const main = logger('HAP Server')
    main.setLogFile(file)
    // about 130 bytes a line: one rotation
    for (let i = 0; i < 25; i++) {
      await write(main, 'line ' + i + ' ' + 'x'.repeat(80))
    }
    await closeAll()
    const rotated = read(file + '.1')
    const current = read(file)
    expect(rotated).to.contain('line 0 ')
    expect(fs.statSync(file).size).to.be.lessThan(2200)
    expect(current).to.contain('line 24 ')
    // no line lost, none twice
    const all = (rotated + current).match(/line \d+ /g)
    expect(all).to.eql(Array.from({ length: 25 }, (_, i) => 'line ' + i + ' '))
  })

  it('makes the configuration service write into the new file, not into the rotated one', async () => {
    const main = logger('HAP Server')
    main.setLogFile(file)
    const config = logger('HAP ConfigServer')
    // the configuration service: the same file, no rotation of its own
    await write(config, 'config before')
    await write(main, 'main ' + 'x'.repeat(2100))
    // the next line of the main process rotates the log
    await write(main, 'main after the rotation')
    expect(fs.existsSync(file + '.1')).to.be(true)
    await write(config, 'config after')
    await closeAll()
    expect(read(file)).to.contain('config after')
    expect(read(file + '.1')).not.to.contain('config after')
    expect(read(file + '.1')).to.contain('config before')
  })

  it('goes on at the start of a log that was emptied, and opens a removed one anew', async () => {
    const main = logger('HAP Server')
    main.setLogFile(file)
    await write(main, 'before clearing')
    fs.truncateSync(file, 0)
    await write(main, 'after clearing')
    expect(read(file).startsWith('[')).to.be(true)
    expect(read(file)).not.to.contain('before clearing')
    expect(read(file)).not.to.contain('\u0000')

    fs.unlinkSync(file)
    await write(main, 'after removing')
    await closeAll()
    expect(read(file)).to.contain('after removing')
  })

  it('does not rotate while running in the configuration service', async () => {
    const config = logger('HAP ConfigServer')
    config.setLogFile(file, false)
    for (let i = 0; i < 30; i++) {
      await write(config, 'config ' + 'x'.repeat(100))
    }
    await closeAll()
    expect(fs.existsSync(file + '.1')).to.be(false)
  })
})
