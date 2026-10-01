'use strict'

// The databases of the CCU (devices, variables, programs, rooms, functions) are cached as files.
// A failed or cut off Rega answer was taken for an empty CCU and saved: one Rega timeout after a
// start emptied all of them, and the next start loaded 0 devices and 0 variables, so all mapped
// accessories disappeared from HomeKit. A missing devices.json was saved without its key and
// loaded as no devices.

const fs = require('fs')
const os = require('os')
const path = require('path')
const expect = require('expect.js')
const HomeMaticCCU = require(path.join(__dirname, '..', 'lib', 'HomeMaticCCU.js'))
const { recordingLog } = require(path.join(__dirname, 'helpers', 'recordingLog.js'))

const ANSWERS = {
  devices: { devices: [{ id: 1, name: 'Klingel', address: '0002DD89A1B2C3', type: 'HmIP-DSD-PCB', channels: [] }] },
  variables: { variables: [{ id: 2, name: 'Anwesenheit', dpInfo: '', valuelist: '', unit: '' }] },
  programs: { programs: [{ id: 3, name: 'Licht aus', dpInfo: '' }] },
  rooms: { rooms: [{ id: 4, name: 'Flur', channels: [] }] },
  functions: { functions: [{ id: 5, name: 'Licht', channels: [] }] }
}
const FILES = Object.keys(ANSWERS).map(key => key + '.json')

// the key of a database script ('!devices\n...')
const keyOf = script => script.slice(1, script.indexOf('\n'))

function ccuWithRega (dir, answer) {
  const ccu = new HomeMaticCCU(recordingLog(), { storagePath: dir })
  ccu.runRega = (tag, script) => new Promise(resolve => resolve(answer(keyOf(script))))
  return ccu
}

const healthy = key => JSON.stringify(ANSWERS[key])
const failing = () => { throw new Error('TimeOut') }
const read = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))

async function loaded (dir) {
  const ccu = ccuWithRega(dir, failing)
  await ccu.loadDatabases(dir)
  return { devices: ccu.getCCUDevices().length, variables: ccu.getVariables().length, programs: ccu.programs.length, rooms: ccu.rooms.length, functions: ccu.functions.length }
}

const ALL_ONE = { devices: 1, variables: 1, programs: 1, rooms: 1, functions: 1 }

describe('HomeKit-CCU cached databases', () => {
  let dir
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkccu-db-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('fetches missing databases and loads them again on the next start', async () => {
    const ccu = ccuWithRega(dir, healthy)
    await ccu.loadDatabases(dir)
    expect(ccu.getCCUDevices().map(d => d.address)).to.eql(['0002DD89A1B2C3'])
    expect(read(dir, 'devices.json')).to.eql(ANSWERS.devices)
    expect(await loaded(dir)).to.eql(ALL_ONE)
  })

  it('keeps the databases when Rega fails, also after the next start', async () => {
    await ccuWithRega(dir, healthy).loadDatabases(dir)
    const ccu = ccuWithRega(dir, failing)
    await ccu.loadDatabases(dir)
    await ccu.updateDatabases(dir)
    await ccu.updateDeviceDatabase()
    expect(ccu.getVariables().map(v => v.name)).to.eql(['Anwesenheit'])
    expect(ccu.getCCUDevices().length).to.be(1)
    for (const file of FILES) {
      expect(read(dir, file)).to.eql(ANSWERS[file.replace('.json', '')])
    }
    expect(await loaded(dir)).to.eql(ALL_ONE)
  })

  it('does not save a cut off answer or an error text of Rega', async () => {
    await ccuWithRega(dir, healthy).loadDatabases(dir)
    const ccu = ccuWithRega(dir, key => key === 'devices' ? '{"devices":[{"id":1,"na' : 'Error: script')
    let changed = 0
    ccu.on('devicelistchanged', () => changed++)
    await ccu.updateDatabases(dir)
    await ccu.updateDeviceDatabase()
    expect(changed).to.be(0)
    expect(await loaded(dir)).to.eql(ALL_ONE)
  })

  it('updates the databases with a complete answer', async () => {
    await ccuWithRega(dir, healthy).loadDatabases(dir)
    const ccu = ccuWithRega(dir, key => key === 'variables' ? JSON.stringify({ variables: [] }) : healthy(key))
    await ccu.loadDatabases(dir)
    let changed = 0
    ccu.on('devicelistchanged', () => changed++)
    await ccu.updateDatabases(dir)
    await ccu.updateDeviceDatabase()
    expect(ccu.getVariables()).to.eql([])
    expect(changed).to.be(1)
    expect(read(dir, 'variables.json')).to.eql({ variables: [] })
  })

  it('fetches a database again that an older version saved empty', async () => {
    fs.writeFileSync(path.join(dir, 'variables.json'), '[]')
    fs.writeFileSync(path.join(dir, 'devices.json'), '{}')
    const ccu = ccuWithRega(dir, healthy)
    await ccu.loadDatabases(dir)
    expect(ccu.getVariables().length).to.be(1)
    expect(ccu.getCCUDevices().length).to.be(1)
    expect(read(dir, 'variables.json')).to.eql(ANSWERS.variables)
  })

  it('starts with empty lists and saves nothing when the CCU does not answer on the first start', async () => {
    const ccu = ccuWithRega(dir, failing)
    await ccu.loadDatabases(dir)
    expect(ccu.getCCUDevices()).to.eql([])
    expect(ccu.getVariables()).to.eql([])
    expect(fs.readdirSync(dir)).to.eql([])
  })

  it('updates the device database again after a failed update', async () => {
    await ccuWithRega(dir, healthy).loadDatabases(dir)
    let fail = true
    const ccu = ccuWithRega(dir, key => fail ? failing() : healthy(key))
    await ccu.loadDatabases(dir)
    await ccu.updateDeviceDatabase()
    expect(ccu.deviceDBUpdateRunning).to.be(false)
    fail = false
    let changed = 0
    ccu.on('devicelistchanged', () => changed++)
    await ccu.updateDeviceDatabase()
    expect(changed).to.be(1)
  })
})
