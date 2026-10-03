'use strict'

// A number variable as sensor (HomeMaticVariableNumberSensorAccessory). A variable of 0 shown as
// light sensor, e.g. the power of a balcony power plant at night, was refused by HomeKit at every
// start and refresh: "characteristic was supplied illegal value: number 0 exceeded minimum of
// 0.0001". The value is now kept within the range of the characteristic, and given as a number
// (it was a text).

const path = require('path')
const expect = require('expect.js')
const { Service, Characteristic } = require('@homebridge/hap-nodejs')
const { startServer, shutdown, settle, watchWarnings } = require(path.join(__dirname, 'helpers', 'sensorsHap.js'))
const { getCharacteristicValue } = require(path.join(__dirname, 'helpers', 'characteristicValue.js'))
const Appliance = require(path.join(__dirname, '..', 'lib', 'services', 'HomeMaticVariableNumberSensorAccessory.js'))

const NAME = 'Balkonkraftwerk_Leistung'

describe('HomeKit-CCU number variable as sensor', () => {
  let server
  let current
  const built = []

  before(async () => {
    ;({ server } = await startServer('HmIP-STH.json'))
    // a number variable (valuetype 4, subtype 0) whose value the test sets
    server._ccu.variables = [{ id: 4711, name: NAME, valuetype: 4, subtype: 0 }]
    server._ccu.getVariableValue = async (name) => current
  })

  after(() => {
    built.forEach(accessory => accessory.shutdown())
    shutdown(server)
  })

  // the accessory the way the server builds one for a mapped variable
  const variableAs = (type) => {
    const accessory = new Appliance({ name: NAME, address: NAME + ':0' }, 'Variable', server, { name: NAME, settings: { Type: type } })
    accessory.variable = server._ccu.variableWithName(NAME)
    accessory.nameInCCU = NAME
    accessory.init()
    built.push(accessory)
    return accessory
  }

  const characteristicOf = (accessory, serviceType, characteristicType) =>
    accessory.getHomeKitAccessory().services.find(service => service.UUID === serviceType.UUID).getCharacteristic(characteristicType)

  const read = (characteristic) => new Promise((resolve, reject) => getCharacteristicValue(characteristic, (error, value) => error ? reject(error) : resolve(value)))

  it('gives a light sensor the minimum of HomeKit for a variable of 0, without a warning', async () => {
    const accessory = variableAs('LuxOmeter')
    const lux = characteristicOf(accessory, Service.LightSensor, Characteristic.CurrentAmbientLightLevel)
    const warnings = watchWarnings(accessory)
    current = '0.000000'
    expect(await read(lux)).to.be(0.0001)
    server._ccu.fireVariableEvent(NAME, '0.000000')
    await settle()
    expect(lux.value).to.be(0.0001)
    server._ccu.fireVariableEvent(NAME, '412.700000')
    await settle()
    expect(lux.value).to.be(413)
    warnings.stop()
    expect(warnings.list).to.eql([])
  })

  it('keeps a brightness and a humidity at most 100, and the lamp is off at 0', async () => {
    const lamp = variableAs('Lightbulb')
    const brightness = characteristicOf(lamp, Service.Lightbulb, Characteristic.Brightness)
    const on = characteristicOf(lamp, Service.Lightbulb, Characteristic.On)
    server._ccu.fireVariableEvent(NAME, '250')
    await settle()
    expect(brightness.value).to.be(100)
    expect(on.value).to.be(true)
    server._ccu.fireVariableEvent(NAME, '0')
    await settle()
    expect(brightness.value).to.be(0)
    expect(on.value).to.be(false)

    const humidity = characteristicOf(variableAs('Humidity'), Service.HumiditySensor, Characteristic.CurrentRelativeHumidity)
    server._ccu.fireVariableEvent(NAME, '57.6')
    await settle()
    expect(humidity.value).to.be(58)
  })

  it('keeps the last value for a variable that is no number', async () => {
    const accessory = variableAs('LuxOmeter')
    const lux = characteristicOf(accessory, Service.LightSensor, Characteristic.CurrentAmbientLightLevel)
    server._ccu.fireVariableEvent(NAME, '120')
    await settle()
    server._ccu.fireVariableEvent(NAME, 'n/a')
    await settle()
    expect(lux.value).to.be(120)
    current = 'n/a'
    expect(await read(lux)).to.be(120)
  })
})
