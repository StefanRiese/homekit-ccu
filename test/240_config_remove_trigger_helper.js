'use strict'

// The helper program of the variable trigger (_hap_autotrigger_) stayed on the CCU when
// "Create/Update the CCU helper program." was switched off, and the settings page could not remove
// it. "Remove helper program" removes it (only a program of that name) and switches the box off,
// so the next save of the trigger does not build it again.

const path = require('path')
const expect = require('expect.js')
const ConfigurationService = require(path.join(__dirname, '..', 'lib', 'configurationsrv', 'ConfigurationService.js'))
const Rega = require(path.join(__dirname, '..', 'lib', 'HomeMaticRegaRequest.js'))

describe('HomeKit-CCU ConfigurationService remove the helper program of the variable trigger', () => {
  let origScript
  beforeEach(() => { origScript = Rega.prototype.script })
  afterEach(() => { Rega.prototype.script = origScript })

  // answer: what Rega writes, or an Error it fails with
  const callApi = async (answer, config = { autoUpdateVarTriggerHelper: true }) => {
    const scripts = []
    Rega.prototype.script = async function (script) {
      scripts.push(script)
      if (answer instanceof Error) {
        throw answer
      }
      return answer
    }
    // bypass the constructor: it reads the real settings from UIX_CONFIG_PATH
    const service = Object.create(ConfigurationService.prototype)
    service.log = { error () {}, warn () {}, info () {}, debug () {} }
    service.useAuth = false
    service.autoUpdateVarTriggerHelper = config.autoUpdateVarTriggerHelper
    service.sendObjects = () => {}
    const saved = []
    service.loadSettings = () => ({ ...config })
    service.saveSettings = (data) => saved.push(data)
    const sent = []
    service.process = { send: (message) => sent.push(message) }
    const response = {
      headersSent: false,
      writeHead () { this.headersSent = true },
      end (body) { this.ended = true; this.body = body }
    }
    await service.processApiCall({ method: 'removeVariableTriggerHelper' }, response)
    return { service, response, sent, saved, scripts }
  }

  it('removes only a program of that name from the CCU', async () => {
    const { response, scripts } = await callApi('removed')
    expect(JSON.parse(response.body)).to.eql({ result: 'removed' })
    expect(scripts.length).to.be(1)
    expect(scripts[0]).to.contain('dom.GetObject("_hap_autotrigger_")')
    expect(scripts[0]).to.contain('p.IsTypeOf(OT_PROGRAM)')
    expect(scripts[0]).to.contain('dom.DeleteObject(p)')
  })

  it('switches the box off and lets the main process read the setting again', async () => {
    const { service, sent, saved } = await callApi('removed')
    expect(service.autoUpdateVarTriggerHelper).to.be(false)
    expect(saved.length).to.be(1)
    expect(saved[0].autoUpdateVarTriggerHelper).to.be(false)
    expect(sent).to.eql([{ topic: 'reloadApplicances' }])
  })

  it('switches the box off also when there is no helper program', async () => {
    const { response, service, saved } = await callApi('not found')
    expect(JSON.parse(response.body)).to.eql({ result: 'not found' })
    expect(service.autoUpdateVarTriggerHelper).to.be(false)
    expect(saved[0].autoUpdateVarTriggerHelper).to.be(false)
  })

  it('saves nothing and reloads nothing when the box is already off', async () => {
    const { response, saved, sent } = await callApi('removed', { autoUpdateVarTriggerHelper: false })
    expect(JSON.parse(response.body)).to.eql({ result: 'removed' })
    expect(saved).to.eql([])
    expect(sent).to.eql([])
  })

  it('keeps the box on when another object has that name', async () => {
    const { response, service, saved, sent } = await callApi('not a program')
    expect(JSON.parse(response.body)).to.eql({ result: 'not a program' })
    expect(service.autoUpdateVarTriggerHelper).to.be(true)
    expect(saved).to.eql([])
    expect(sent).to.eql([])
  })

  it('answers failed and keeps the box on when the CCU does not answer', async () => {
    const { response, service, saved } = await callApi(new Error('TimeOut'))
    expect(JSON.parse(response.body)).to.eql({ result: 'failed' })
    expect(service.autoUpdateVarTriggerHelper).to.be(true)
    expect(saved).to.eql([])
  })

  it('sends the saved box with the variable list right after "Update Trigger"', async () => {
    // the box was switched off by a removal; the page ticks it and saves the trigger again
    const service = Object.create(ConfigurationService.prototype)
    service.log = { error () {}, warn () {}, info () {}, debug () {} }
    service.useAuth = false
    service.pluginVariables = []
    service.pluginVariableTrigger = 'HmIP-RF.HmIP-RCV-1:50.PRESS_SHORT'
    service.autoUpdateVarTriggerHelper = false
    service.getVariableServiceList = () => []
    service.sendObjects = () => {}
    let config = { VariableUpdateEvent: 'HmIP-RF.HmIP-RCV-1:50.PRESS_SHORT', autoUpdateVarTriggerHelper: false }
    service.loadSettings = () => ({ ...config })
    service.saveSettings = (data) => { config = data }
    const sent = []
    service.process = { send: (message) => sent.push(message) }
    const answer = () => ({ writeHead () {}, end (body) { this.body = body } })

    const save = answer()
    await service.processApiCall({ method: 'saveVariableTrigger', datapoint: 'HmIP-RF.HmIP-RCV-1:51.PRESS_SHORT', autoUpdateVarTriggerHelper: 'true' }, save)
    expect(JSON.parse(save.body)).to.eql({ result: 'saved' })
    expect(sent.map(message => message.topic)).to.eql(['reloadApplicances', 'createTrigger'])

    // before the main process has sent the setting again
    const list = answer()
    await service.processApiCall({ method: 'variablelist' }, list)
    expect(JSON.parse(list.body).autoUpdateVarTriggerHelper).to.be(true)
    expect(JSON.parse(list.body).trigger).to.be('HmIP-RF.HmIP-RCV-1:51.PRESS_SHORT')
  })

  it('sends the state of the box with the variable list', async () => {
    const service = Object.create(ConfigurationService.prototype)
    service.log = { error () {}, warn () {}, info () {}, debug () {} }
    service.useAuth = false
    service.pluginVariables = []
    service.pluginVariableTrigger = 'HmIP-RF.HmIP-RCV-1:50.PRESS_SHORT'
    service.autoUpdateVarTriggerHelper = true
    service.getVariableServiceList = () => []
    const response = { end (body) { this.body = body }, writeHead () {} }
    await service.processApiCall({ method: 'variablelist' }, response)
    expect(JSON.parse(response.body).autoUpdateVarTriggerHelper).to.be(true)
  })
})
