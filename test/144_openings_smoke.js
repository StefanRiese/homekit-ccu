const path = require('path')
const expect = require('expect.js')
const { Service, Characteristic } = require('@homebridge/hap-nodejs')
const { simulateDevice, read, findService } = require(path.join(__dirname, 'helpers', 'openingsHarness.js'))

const Smoke = Characteristic.SmokeDetected
const Fault = Characteristic.StatusFault

const SWSD = {
  type: 'HmIP-SWSD',
  channels: ['MAINTENANCE', 'SMOKE_DETECTOR'],
  channel: 1,
  service: 'HomeMaticIPSmokeDetectorAccessory',
  values: { '0.LOW_BAT': false, '0.UNREACH': false, '0.ERROR_DEGRADED_CHAMBER': false, '1.SMOKE_DETECTOR_TEST_RESULT': 0 }
}

describe('Openings: HmIP-SWSD smoke detector', () => {
  let sim
  let sensor
  let smoke

  before(async () => {
    sim = await simulateDevice(Object.assign({ address: '0001D3C99CD001' }, SWSD))
    sensor = findService(sim.accessory, Service.SmokeSensor)
    smoke = sensor.getCharacteristic(Smoke)
  })

  after(() => sim.shutdown())

  it('answers the read before the CCU sent a value', async () => {
    expect(await read(smoke)).to.be(Smoke.SMOKE_NOT_DETECTED)
    expect(await read(sensor.getCharacteristic(Fault))).to.be(Fault.NO_FAULT)
    expect(sim.warnings).to.eql([])
  })

  it('shows the primary alarm', async () => {
    sim.fire('1.SMOKE_DETECTOR_ALARM_STATUS', 1)
    expect(smoke.value).to.be(Smoke.SMOKE_DETECTED)
    sim.fire('1.SMOKE_DETECTOR_ALARM_STATUS', 0)
    expect(smoke.value).to.be(Smoke.SMOKE_NOT_DETECTED)
  })

  it('handles the strings the CCU script interface returns', async () => {
    sim.fire('1.SMOKE_DETECTOR_ALARM_STATUS', '1')
    expect(smoke.value).to.be(Smoke.SMOKE_DETECTED)
    expect(await read(smoke)).to.be(Smoke.SMOKE_DETECTED)
    sim.fire('1.SMOKE_DETECTOR_ALARM_STATUS', '0')
    expect(smoke.value).to.be(Smoke.SMOKE_NOT_DETECTED)
  })

  it('shows the alarm of another detector of the team', async () => {
    sim.fire('1.SMOKE_DETECTOR_ALARM_STATUS', 3)
    expect(smoke.value).to.be(Smoke.SMOKE_DETECTED)
    sim.fire('1.SMOKE_DETECTOR_ALARM_STATUS', 0)
  })

  it('reports a degraded smoke chamber as fault', async () => {
    const fault = sensor.getCharacteristic(Fault)
    sim.fire('0.ERROR_DEGRADED_CHAMBER', true)
    expect(fault.value).to.be(Fault.GENERAL_FAULT)
    expect(await read(fault)).to.be(Fault.GENERAL_FAULT)
    sim.fire('0.ERROR_DEGRADED_CHAMBER', false)
    expect(fault.value).to.be(Fault.NO_FAULT)
  })

  it('reports a failed smoke test as fault', async () => {
    const fault = sensor.getCharacteristic(Fault)
    sim.fire('1.SMOKE_DETECTOR_TEST_RESULT', 2)
    expect(fault.value).to.be(Fault.GENERAL_FAULT)
    sim.fire('1.SMOKE_DETECTOR_TEST_RESULT', 1)
    expect(fault.value).to.be(Fault.NO_FAULT)
  })

  it('reports an unreachable detector as fault', async () => {
    const fault = sensor.getCharacteristic(Fault)
    sim.fire('0.UNREACH', true)
    expect(fault.value).to.be(Fault.GENERAL_FAULT)
    sim.fire('0.UNREACH', false)
    expect(await read(fault)).to.be(Fault.NO_FAULT)
  })

  it('reports the battery', async () => {
    const battery = findService(sim.accessory, Service.Battery)
    sim.fire('0.LOW_BAT', true)
    expect(await read(battery.getCharacteristic(Characteristic.StatusLowBattery))).to.be(Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW)
    expect(sim.warnings).to.eql([])
  })
})

describe('Openings: HmIP-SWSD detecting only its own alarm', () => {
  let sim
  let smoke

  before(async () => {
    sim = await simulateDevice(Object.assign({ address: '0001D3C99CD002', settings: { single_alarm: true } }, SWSD))
    smoke = findService(sim.accessory, Service.SmokeSensor).getCharacteristic(Smoke)
  })

  after(() => sim.shutdown())

  it('ignores the alarm of another detector', async () => {
    sim.fire('1.SMOKE_DETECTOR_ALARM_STATUS', 1)
    expect(smoke.value).to.be(Smoke.SMOKE_DETECTED)
    sim.fire('1.SMOKE_DETECTOR_ALARM_STATUS', 3)
    expect(smoke.value).to.be(Smoke.SMOKE_NOT_DETECTED)
    expect(await read(smoke)).to.be(Smoke.SMOKE_NOT_DETECTED)
  })
})

describe('Openings: HM-Sec-SD-2 smoke detector', () => {
  let sim
  let sensor

  before(async () => {
    sim = await simulateDevice({
      type: 'HM-Sec-SD-2',
      intf: 'BidCos-RF',
      address: 'NEQ0000001',
      channels: ['MAINTENANCE', 'SMOKE_DETECTOR'],
      channel: 1,
      service: 'HomeMaticSmokeDetectorAccessory',
      values: { '0.LOWBAT': false, '1.LOWBAT': false, '1.STATE': false, '1.ERROR_SMOKE_CHAMBER': 0 }
    })
    sensor = findService(sim.accessory, Service.SmokeSensor)
  })

  after(() => sim.shutdown())

  it('shows the alarm', async () => {
    const smoke = sensor.getCharacteristic(Smoke)
    sim.fire('1.STATE', true)
    expect(smoke.value).to.be(Smoke.SMOKE_DETECTED)
    sim.fire('1.STATE', false)
    expect(await read(smoke)).to.be(Smoke.SMOKE_NOT_DETECTED)
  })

  // ERROR_SMOKE_CHAMBER of channel 1: 0 no error, 1 degraded smoke chamber
  it('reports a degraded smoke chamber as fault', async () => {
    const fault = sensor.getCharacteristic(Fault)
    expect(await read(fault)).to.be(Fault.NO_FAULT)
    sim.fire('1.ERROR_SMOKE_CHAMBER', 1)
    expect(fault.value).to.be(Fault.GENERAL_FAULT)
    expect(await read(fault)).to.be(Fault.GENERAL_FAULT)
    sim.fire('1.ERROR_SMOKE_CHAMBER', 0)
    expect(fault.value).to.be(Fault.NO_FAULT)
    expect(sim.warnings).to.eql([])
  })
})
