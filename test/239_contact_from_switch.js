'use strict'

// https://github.com/bloop16/homekit-ccu/issues/22: a CUxD universal control unit set up as SWITCH
// (STATE on/off) could only be a switch, light, outlet or fan in Apple Home, not a window contact.
// The contact sensor can be chosen for a SWITCH channel now; the switch stays its default.

const path = require('path')
const expect = require('expect.js')
const { Service, Characteristic } = require('@homebridge/hap-nodejs')
const { simulateDevice, read, settle, findService } = require(path.join(__dirname, 'helpers', 'openingsHarness.js'))
const Server = require(path.join(__dirname, '..', 'lib', 'Server.js'))
const { orderedServicesForChannel } = require(path.join(__dirname, '..', 'lib', 'util', 'defaultServices.js'))

const quietLog = { debug () {}, info () {}, warn () {}, error () {}, isDebugEnabled: () => false }

describe('HomeKit-CCU switch channel as contact', () => {
  it('offers the contact sensor for a switch channel, the switch stays the default', async () => {
    const server = new Server(quietLog)
    server.log = quietLog
    const serviceConfig = await server.buildServiceList()
    const list = orderedServicesForChannel(serviceConfig, 'HM-LC-Sw1-Pl-CT-R1', 'SWITCH').map(entry => entry.serviceClazz)
    expect(list[0]).to.be('HomeMaticSwitchAccessory')
    expect(list).to.contain('HomeMaticContactSensorAccessory')
  })

  const contactOf = async (settings) => {
    const sim = await simulateDevice({
      type: 'HM-LC-Sw1-Pl-CT-R1',
      address: 'CUX4000001',
      intf: 'CUxD',
      channels: ['MAINTENANCE', 'SWITCH'],
      channel: 1,
      service: 'HomeMaticContactSensorAccessory',
      settings,
      values: { '1.STATE': false }
    })
    return { sim, state: findService(sim.accessory, Service.ContactSensor).getCharacteristic(Characteristic.ContactSensorState) }
  }

  it('shows STATE on as open and off as closed', async () => {
    const { sim, state } = await contactOf({})
    try {
      expect(await read(state)).to.be(Characteristic.ContactSensorState.CONTACT_DETECTED)
      sim.fire('1.STATE', true)
      await settle()
      expect(state.value).to.be(Characteristic.ContactSensorState.CONTACT_NOT_DETECTED)
    } finally {
      sim.shutdown()
    }
  })

  it('turns it around with reverse', async () => {
    const { sim, state } = await contactOf({ reverse: true })
    try {
      expect(await read(state)).to.be(Characteristic.ContactSensorState.CONTACT_NOT_DETECTED)
      sim.fire('1.STATE', true)
      await settle()
      expect(state.value).to.be(Characteristic.ContactSensorState.CONTACT_DETECTED)
    } finally {
      sim.shutdown()
    }
  })
})
