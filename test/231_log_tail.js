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
    write(numbers(800))
    const first = await readLogTail(file)
    expect(first.lines.length).to.be(500)
    expect(first.lines[0]).to.be(line(301))
    expect(first.lines[499]).to.be(line(800))
    expect(first.offset).to.be(fs.statSync(file).size)

    const nothing = await readLogTail(file, { offset: first.offset, file: first.file })
    expect(nothing.lines).to.eql([])
    expect(nothing.offset).to.be(first.offset)

    append(line(801) + '\n' + line(802) + '\n')
    const next = await readLogTail(file, { offset: first.offset, file: first.file })
    expect(next.lines).to.eql([line(801), line(802)])
    expect(next.reset).to.be(false)
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
    const tail = await readLogTail(file, { maxBytes: 1000 })
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
    const tail = await readLogTail(file, { maxBytes: 100 })
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
    expect(await readLogTail(file)).to.eql({ offset: 0, file: 0, lines: [], reset: false, skipped: false })
    expect(await readLogTail(undefined)).to.eql({ offset: 0, file: 0, lines: [], reset: false, skipped: false })
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
  })
})
