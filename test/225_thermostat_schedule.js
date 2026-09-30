'use strict'

// The Eve schedule of the HM-TC-IT-WM-W-EU (HomeMaticProgrammableThermostatAccessory): its week
// program and the high and low temperature are kept in the persistent values of the accessory
// and read again after a restart. The low temperature was saved as tempLow but read as tempLo,
// so it came back as 17 °C and was sent to the thermostat with the next schedule.

const path = require('path')
const expect = require('expect.js')
const Thermostat = require(path.join(__dirname, '..', 'lib', 'services', 'HomeMaticProgrammableThermostatAccessory.js'))

const PROGRAM = { periods: [], hex: 'ffffffffffffffff' }

// the schedule part of an accessory, with persistent values in memory
function thermostat (store) {
  const accessory = Object.create(Thermostat.prototype)
  accessory.getPersistentValue = (key, fallback) => (store[key] !== undefined) ? store[key] : fallback
  accessory.savePersistentValue = (key, value) => { store[key] = JSON.parse(JSON.stringify(value)) }
  accessory.debugLog = () => {}
  accessory.errorLog = () => {}
  accessory.sent = []
  accessory.sendProgramToDevice = async (schedules) => { accessory.sent.push(schedules) }
  for (let day = 1; day <= 7; day++) {
    accessory['program' + day] = PROGRAM
  }
  accessory.programFree = PROGRAM
  return accessory
}

describe('HomeKit-CCU Eve schedule of the programmable thermostat', () => {
  it('reads the low and the high temperature again after a restart', () => {
    const store = {}
    const before = thermostat(store)
    before.tempLo = 15.5
    before.tempHi = 22
    before.saveAndEnableSchedules(null)
    expect(before.sent.length).to.be(1)

    const after = thermostat(store)
    expect(after.loadSchedules()).to.be(true)
    expect(after.tempLo).to.be(15.5)
    expect(after.tempHi).to.be(22)
  })

  it('does not send an unchanged schedule to the thermostat again after a restart', () => {
    const store = {}
    const before = thermostat(store)
    before.tempLo = 15.5
    before.tempHi = 22
    before.saveAndEnableSchedules(null)

    const after = thermostat(store)
    after.loadSchedules()
    after.saveAndEnableSchedules(null)
    expect(after.sent).to.eql([])
  })

  it('takes 17 and 21 °C when the schedule has no temperatures', () => {
    const store = { prgtemp: { programms: { 1: PROGRAM, 2: PROGRAM, 3: PROGRAM, 4: PROGRAM, 5: PROGRAM, 6: PROGRAM, 7: PROGRAM, f: PROGRAM } } }
    const accessory = thermostat(store)
    expect(accessory.loadSchedules()).to.be(true)
    expect(accessory.tempLo).to.be(17)
    expect(accessory.tempHi).to.be(21)
  })
})
