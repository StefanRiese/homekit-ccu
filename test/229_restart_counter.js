'use strict'

// restartCounter.json is written at every start. A file that is empty or cut off (power loss)
// threw while the Server was created, so the add-on could not start at all.

const path = require('path')
const os = require('os')
const fs = require('fs')
const { spawnSync } = require('child_process')
const expect = require('expect.js')
const { readRestartCount, writeRestartCount } = require(path.join(__dirname, '..', 'lib', 'util', 'restartCounter.js'))

const recordingLog = () => {
  const log = { messages: [] }
  log.warn = (...args) => log.messages.push(args.join(' '))
  return log
}

describe('HomeKit-CCU restart counter', () => {
  let dir
  let file
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkccu-229-'))
    file = path.join(dir, 'restartCounter.json')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('counts from 0 without a file', () => {
    const log = recordingLog()
    expect(readRestartCount(file, log)).to.be(0)
    expect(log.messages).to.eql([])
  })

  it('reads what was written, and writes it whole', () => {
    writeRestartCount(file, 3, recordingLog())
    writeRestartCount(file, 4, recordingLog())
    expect(readRestartCount(file, recordingLog())).to.be(4)
    expect(fs.readdirSync(dir)).to.eql(['restartCounter.json'])
  })

  const unusable = { 'an empty file': '', 'a cut off file': '[', text: 'hello', 'a text value': '"3"', 'a negative number': '-2', 'a fraction': '1.5', null: 'null', 'an object': '{"a":1}' }
  Object.keys(unusable).forEach(name => {
    it('counts from 0 with ' + name + ' and warns once', () => {
      fs.writeFileSync(file, unusable[name])
      const log = recordingLog()
      expect(readRestartCount(file, log)).to.be(0)
      expect(log.messages.length).to.be(1)
      expect(log.messages[0]).to.contain('restartCounter.json')
    })
  })

  it('logs a count that cannot be saved and goes on', () => {
    const log = recordingLog()
    writeRestartCount(path.join(dir, 'missing', 'restartCounter.json'), 1, log)
    expect(log.messages.length).to.be(1)
    expect(log.messages[0]).to.contain('unable to save')
  })

  it('lets the Server start with a damaged counter file (own process: the Server sets global storage paths)', function () {
    this.timeout(30000)
    fs.mkdirSync(path.join(dir, 'persist'))
    fs.writeFileSync(path.join(dir, 'persist', 'restartCounter.json'), '')
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ccuIP: '127.0.0.1', enableMonitoring: false }))
    const script = `
      const Logger = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'logger.js'))})
      const Server = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'Server.js'))})
      const log = new Logger('restart counter test')
      log.setDebugEnabled(false)
      new Server(log, ${JSON.stringify(dir)}).init(true).then(() => { console.log('INIT OK'); process.exit(0) }, (e) => { console.log('INIT FAILED ' + e.message); process.exit(1) })
    `
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 25000 })
    const output = result.stdout + result.stderr
    expect(output).to.contain('INIT OK')
    expect(output).to.contain('counting from 0')
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'persist', 'restartCounter.json')))).to.be(1)
  })
})
