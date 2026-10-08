'use strict'

// "Create/Update the CCU helper program" could not be switched off. The main process sends the
// saved setting with every 'serverdata' message, but the configuration service only took it over
// when it was on: a saved false kept the old true, the page showed the box ticked again, and the
// next save of the trigger variable switched it back on.

const path = require('path')
const expect = require('expect.js')
const ConfigurationService = require(path.join(__dirname, '..', 'lib', 'configurationsrv', 'ConfigurationService.js'))

describe('HomeKit-CCU ConfigurationService helper program switch', () => {
  let service
  let pushed

  beforeEach(() => {
    // bypass the constructor: it reads the real settings from UIX_CONFIG_PATH
    service = Object.create(ConfigurationService.prototype)
    service.log = { error () {}, warn () {}, info () {}, debug () {} }
    pushed = []
    service.getCCUFirewallConfiguration = async () => undefined
    service.getVariableServiceList = () => []
    service.sendMessageToSockets = (message) => pushed.push(message)
  })

  const settle = () => new Promise(resolve => setImmediate(resolve))

  const serverdata = (fields) => service.handleIncommingIPCMessage(Object.assign({ topic: 'serverdata' }, fields))

  it('takes over a switched off helper program and sends it to the page', async () => {
    serverdata({ autoUpdateVarTriggerHelper: true })
    expect(service.autoUpdateVarTriggerHelper).to.be(true)

    serverdata({ autoUpdateVarTriggerHelper: false })
    expect(service.autoUpdateVarTriggerHelper).to.be(false)
    await settle()
    expect(pushed[pushed.length - 1].payload.autoUpdateVarTriggerHelper).to.be(false)
  })

  it('keeps the setting when the message does not carry it', () => {
    serverdata({ autoUpdateVarTriggerHelper: true })
    serverdata({ variables: [] })
    expect(service.autoUpdateVarTriggerHelper).to.be(true)
  })
})
