'use strict'

// The log view of the settings page reads the end of the log and then only the lines written
// since, never the whole file (it grows until it is rotated, on a CCU to several MB).

const fs = require('fs')
const os = require('os')
const path = require('path')
const expect = require('expect.js')
const { readLogTail } = require(path.join(__dirname, '..', 'lib', 'util', 'logTail.js'))
const ConfigurationService = require(path.join(__dirname, '..', 'lib', 'configurationsrv', 'ConfigurationService.js'))

const line = (n) => `[10/2/2026, 8:00:${String(n % 60).padStart(2, '0')} AM] info - [HAP Server] line ${n}`

describe('HomeKit-CCU log view: end of the log', () => {
  let dir
  let file
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkccu-log-'))
    file = path.join(dir, 'homekit-ccu.log')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const write = (lines) => fs.writeFileSync(file, lines.map(l => l + '\n').join(''))
  const append = (text) => fs.appendFileSync(file, text)
  const numbers = (n) => Array.from({ length: n }, (_, i) => line(i + 1))

  it('starts with the last lines and goes on with the new ones only', async () => {
    write(numbers(1500))
    const first = await readLogTail(file)
    expect(first.lines.length).to.be(1000)
    expect(first.lines[0]).to.be(line(501))
    expect(first.lines[999]).to.be(line(1500))
    expect(first.offset).to.be(fs.statSync(file).size)

    const nothing = await readLogTail(file, { offset: first.offset, file: first.file })
    expect(nothing.lines).to.eql([])
    expect(nothing.offset).to.be(first.offset)

    append(line(1501) + '\n' + line(1502) + '\n')
    const next = await readLogTail(file, { offset: first.offset, file: first.file })
    expect(next.lines).to.eql([line(1501), line(1502)])
    expect(next.reset).to.be(false)
  })

  it('reads further back for 1000 long lines, at most 1 MB', async () => {
    const long = (n) => line(n) + ' ' + 'x'.repeat(600)
    write(Array.from({ length: 2000 }, (_, i) => long(i + 1)))
    const tail = await readLogTail(file)
    expect(tail.lines.length).to.be(1000)
    expect(tail.lines[999]).to.be(long(2000))
  })

  it('sends a line only once it is complete', async () => {
    write(numbers(2))
    const first = await readLogTail(file)
    append('[10/2/2026, 8:01:00 AM] warn - half')
    const half = await readLogTail(file, first)
    expect(half.lines).to.eql([])
    expect(half.offset).to.be(first.offset)
    append(' a line\n')
    expect((await readLogTail(file, half)).lines).to.eql(['[10/2/2026, 8:01:00 AM] warn - half a line'])
  })

  it('reads at most maxBytes from the end and leaves out the line cut there', async () => {
    write(numbers(1000))
    const tail = await readLogTail(file, { maxBytes: 1000, scanBytes: 1000 })
    expect(tail.lines.length).to.be.lessThan(20)
    expect(tail.lines[tail.lines.length - 1]).to.be(line(1000))
    // every line is whole
    tail.lines.forEach(l => expect(l).to.match(/^\[10\/2\/2026, .* line \d+$/))

    // more new lines than maxBytes: the newest ones, marked as skipped
    const before = await readLogTail(file)
    append(numbers(2000).map(l => l + '\n').join(''))
    const after = await readLogTail(file, { offset: before.offset, file: before.file, maxBytes: 1000 })
    expect(after.skipped).to.be(true)
    expect(after.lines[after.lines.length - 1]).to.be(line(2000))
    after.lines.forEach(l => expect(l).to.match(/ line \d+$/))
  })

  it('cuts multi-byte characters at a line, not in the middle', async () => {
    write(['[x] info - Küche Tür Bad ä ö ü ß €'.repeat(10), 'zweite Zeile mit Umlauten: Schlafzimmer, Kühlschrank'])
    const tail = await readLogTail(file, { maxBytes: 100, scanBytes: 100 })
    expect(tail.lines).to.eql(['zweite Zeile mit Umlauten: Schlafzimmer, Kühlschrank'])
    expect(tail.offset).to.be(fs.statSync(file).size)
  })

  it('starts anew when the log was emptied or rotated', async () => {
    write(numbers(50))
    const first = await readLogTail(file)

    fs.writeFileSync(file, line(1) + '\n')
    const emptied = await readLogTail(file, first)
    expect(emptied.reset).to.be(true)
    expect(emptied.lines).to.eql([line(1)])

    // rotated: a new file that is already longer than the old offset
    fs.renameSync(file, file + '.1')
    write(numbers(100))
    const rotated = await readLogTail(file, emptied)
    expect(rotated.reset).to.be(true)
    expect(rotated.lines[rotated.lines.length - 1]).to.be(line(100))
  })

  it('answers no lines while there is no log file', async () => {
    const none = { offset: 0, file: 0, last: 'info', lines: [], lineLevels: [], reset: false, skipped: false }
    expect(await readLogTail(file)).to.eql(none)
    expect(await readLogTail(undefined)).to.eql(none)
  })

  // a log full of debug lines: 499 of the last 500 lines were debug ones on a CCU with debug on
  const debugFlood = (n) => Array.from({ length: n }, (_, i) => `[10/2/2026, 8:41:${String(i % 60).padStart(2, '0')} AM] debug - [HAP ConfigServer] probing channel ${i}`)

  it('reads further back for the levels asked for, when debug lines fill the end of the log', async () => {
    write(['[10/2/2026, 7:00:00 AM] info - [HAP Server] started', '[10/2/2026, 7:00:01 AM] error - [HAP Server] TypeError: x', '    at Server.reload (Server.js:12:3)', '[10/2/2026, 7:00:02 AM] warn - [HAP Server] slow', ...debugFlood(20000)])
    expect(fs.statSync(file).size).to.be.greaterThan(1024 * 1024)
    const all = await readLogTail(file)
    expect(all.lineLevels.every(level => level === 'debug')).to.be(true)

    const noDebug = await readLogTail(file, { levels: ['error', 'warn', 'info'] })
    expect(noDebug.lines).to.eql(['[10/2/2026, 7:00:00 AM] info - [HAP Server] started', '[10/2/2026, 7:00:01 AM] error - [HAP Server] TypeError: x', '    at Server.reload (Server.js:12:3)', '[10/2/2026, 7:00:02 AM] warn - [HAP Server] slow'])
    expect(noDebug.lineLevels).to.eql(['info', 'error', 'error', 'warn'])
    expect(noDebug.since).to.be('10/2/2026, 7:00:00 AM')
    expect(noDebug.offset).to.be(fs.statSync(file).size)
    expect(noDebug.last).to.be('debug')

    expect((await readLogTail(file, { levels: ['error'] })).lines).to.eql(['[10/2/2026, 7:00:01 AM] error - [HAP Server] TypeError: x', '    at Server.reload (Server.js:12:3)'])
    // no level switched on: no line
    expect((await readLogTail(file, { levels: [] })).lines).to.eql([])
  })

  it('reads back at most scanBytes, and tells how far back it read', async () => {
    write(['[10/2/2026, 6:00:00 AM] warn - [HAP Server] long ago', ...debugFlood(20000)])
    const tail = await readLogTail(file, { levels: ['warn'], scanBytes: 512 * 1024 })
    expect(tail.lines).to.eql([])
    expect(tail.since).to.match(/^10\/2\/2026, 8:41:\d\d AM$/)
    expect((await readLogTail(file, { levels: ['warn'] })).lines).to.eql(['[10/2/2026, 6:00:00 AM] warn - [HAP Server] long ago'])
  })

  it('filters the new lines too, a stack trace across two calls with the level of its line', async () => {
    write(['[10/2/2026, 8:00:00 AM] info - a'])
    const first = await readLogTail(file, { levels: ['error', 'warn'] })
    append('[10/2/2026, 8:00:01 AM] debug - b\n[10/2/2026, 8:00:02 AM] error - c\n    at d\n')
    const next = await readLogTail(file, { offset: first.offset, file: first.file, last: first.last, levels: ['error', 'warn'] })
    expect(next.lines).to.eql(['[10/2/2026, 8:00:02 AM] error - c', '    at d'])
    expect(next.last).to.be('error')
    append('    at e\n[10/2/2026, 8:00:03 AM] debug - f\n')
    const more = await readLogTail(file, { offset: next.offset, file: next.file, last: next.last, levels: ['error', 'warn'] })
    expect(more.lines).to.eql(['    at e'])
    expect(more.lineLevels).to.eql(['error'])
  })

  it('clears the log and its older part on the settings page, and the view starts anew', async () => {
    write(numbers(30))
    fs.writeFileSync(file + '.1', 'older part\n')
    const infos = []
    const service = Object.create(ConfigurationService.prototype)
    service.log = { error () {}, warn () {}, info: (...args) => infos.push(args[0]), debug () {} }
    service.useAuth = false
    service.logfile = file
    const before = await readLogTail(file)
    const response = { headersSent: false, writeHead () { this.headersSent = true }, end (body) { this.body = body } }
    await service.processApiCall({ method: 'clearLog' }, response)
    expect(JSON.parse(response.body)).to.eql({ result: 'cleared' })
    expect(fs.statSync(file).size).to.be(0)
    expect(fs.existsSync(file + '.1')).to.be(false)
    expect(infos).to.eql(['[Config] the log was cleared on the settings page'])
    // an open view goes on with the new log
    append(line(1) + '\n')
    const after = await readLogTail(file, before)
    expect(after.reset).to.be(true)
    expect(after.lines).to.eql([line(1)])

    service.logfile = undefined
    expect(await service.clearLog()).to.eql({ result: 'no log' })
  })

  it('is an api call of the configuration service', async () => {
    write(numbers(3))
    const service = Object.create(ConfigurationService.prototype)
    service.log = { error () {}, warn () {}, info () {}, debug () {} }
    service.useAuth = false
    service.logfile = file
    const call = async (query) => {
      const response = { headersSent: false, writeHead () { this.headersSent = true }, end (body) { this.body = body } }
      await service.processApiCall(query, response)
      return JSON.parse(response.body)
    }
    const first = await call({ method: 'logTail' })
    expect(first.lines).to.eql(numbers(3))
    append(line(4) + '\n')
    // the page sends the numbers as text; anything else starts from the end
    const next = await call({ method: 'logTail', offset: String(first.offset), file: String(first.file) })
    expect(next.lines).to.eql([line(4)])
    expect((await call({ method: 'logTail', offset: '../etc', file: 'x' })).lines).to.eql(numbers(4))
    // the levels of the view; unknown ones are left out
    append('[10/2/2026, 8:00:05 AM] warn - w\n')
    expect((await call({ method: 'logTail', levels: 'warn,nonsense' })).lines).to.eql(['[10/2/2026, 8:00:05 AM] warn - w'])
    expect((await call({ method: 'logTail', levels: '' })).lines).to.eql([])
  })
})
