'use strict'

// The .pstore file of an accessory (last activation, reset time, ...) is read when the accessory
// is created. A file that is empty or cut off (power loss, full disk) used to throw there, so the
// device could not be added (hap-homematic #625: "Unexpected end of JSON input").

const path = require('path')
const os = require('os')
const fs = require('fs')
const expect = require('expect.js')
const { loadStore, saveStore } = require(path.join(__dirname, '..', 'lib', 'util', 'persistentStore.js'))
const HomeMaticAccessory = require(path.join(__dirname, '..', 'lib', 'services', 'HomeMaticAccessory.js'))

const recordingLog = () => {
  const log = { messages: [] }
  ;['warn', 'error'].forEach(level => { log[level] = (...args) => log.messages.push(level + ' ' + args.join(' ')) })
  log.debug = () => {}
  return log
}

describe('HomeKit-CCU persistent store of an accessory', () => {
  let dir
  let file
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkccu-228-'))
    file = path.join(dir, 'host_0002DD89A1B2C3_1.pstore')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('starts empty without a file', () => {
    const log = recordingLog()
    expect(loadStore(file, log)).to.eql({})
    expect(log.messages).to.eql([])
  })

  it('keeps what was saved', () => {
    saveStore(file, { lastActivation: 1234, lastReset: 5 })
    expect(loadStore(file, recordingLog())).to.eql({ lastActivation: 1234, lastReset: 5 })
  })

  it('writes the file whole: no half written file is ever at its place, no temporary file stays', () => {
    saveStore(file, { a: 1 })
    saveStore(file, { a: 2 })
    expect(fs.readdirSync(dir)).to.eql(['host_0002DD89A1B2C3_1.pstore'])
    expect(JSON.parse(fs.readFileSync(file))).to.eql({ a: 2 })
  })

  const broken = {
    'an empty file': '',
    'a cut off file': '{"lastActivation": 12',
    'text that is no JSON': 'hello',
    'JSON that is no object': '[1,2]',
    null: 'null'
  }
  Object.keys(broken).forEach(name => {
    it('starts empty with ' + name + ', warns once and keeps the file for a look', () => {
      fs.writeFileSync(file, broken[name])
      const log = recordingLog()
      expect(loadStore(file, log)).to.eql({})
      expect(log.messages.length).to.be(1)
      expect(log.messages[0]).to.contain('warn')
      expect(log.messages[0]).to.contain('host_0002DD89A1B2C3_1.pstore')
      expect(fs.existsSync(file)).to.be(false)
      expect(fs.readFileSync(file + '.corrupt').toString()).to.be(broken[name])
      // the next save starts a good file, the next load is quiet
      saveStore(file, { lastActivation: 7 })
      const again = recordingLog()
      expect(loadStore(file, again)).to.eql({ lastActivation: 7 })
      expect(again.messages).to.eql([])
    })
  })

  it('replaces an older .corrupt file', () => {
    fs.writeFileSync(file + '.corrupt', 'old')
    fs.writeFileSync(file, '{')
    loadStore(file, recordingLog())
    expect(fs.readFileSync(file + '.corrupt').toString()).to.be('{')
  })

  it('is used by the accessory: loading and saving survive a bad file and a full disk', () => {
    const log = recordingLog()
    const accessory = { runsInTestMode: false, _persistentStore: file, _persistentValues: {}, log }
    fs.writeFileSync(file, '')
    HomeMaticAccessory.prototype.loadPersistentValues.call(accessory)
    expect(accessory._persistentValues).to.eql({})
    HomeMaticAccessory.prototype.savePersistentValue.call(accessory, 'lastActivation', 9)
    expect(JSON.parse(fs.readFileSync(file))).to.eql({ lastActivation: 9 })
    // a place that cannot be written: the value stays in memory, the failure is in the log
    accessory._persistentStore = path.join(dir, 'missing', 'x.pstore')
    HomeMaticAccessory.prototype.savePersistentValue.call(accessory, 'lastActivation', 10)
    expect(accessory._persistentValues.lastActivation).to.be(10)
    expect(log.messages.filter(m => m.startsWith('error')).length).to.be(1)
  })

  it('does not touch files in test mode', () => {
    const accessory = { runsInTestMode: true, _persistentStore: file, _persistentValues: {}, log: recordingLog() }
    HomeMaticAccessory.prototype.savePersistentValue.call(accessory, 'a', 1)
    expect(fs.existsSync(file)).to.be(false)
  })
})
