'use strict'

// Adding a program never worked since 0.1.0-rc.10: the dialog sends no service class (a program
// has only one), and the hardened configuration service refuses a save without a known class.
// Nothing was stored, and the dialog closed as if it had worked.

const path = require('path')
const { pathToFileURL } = require('url')
const expect = require('expect.js')
const ConfigurationService = require(path.join(__dirname, '..', 'lib', 'configurationsrv', 'ConfigurationService.js'))

const quietLog = { debug () {}, info () {}, warn () {}, error () {} }

function service (config) {
  const instance = Object.create(ConfigurationService.prototype)
  instance.log = quietLog
  instance.bridges = [{ id: 'bridge-1', port: 9877 }]
  instance.compatiblePrograms = [{ id: 1234, name: 'Alles aus' }]
  instance.loadSettings = () => config
  instance.saved = undefined
  instance.saveSettings = (settings) => { instance.saved = JSON.parse(JSON.stringify(settings)) }
  instance.messages = []
  instance.process = { send: (message) => instance.messages.push(message.topic) }
  return instance
}

describe('HomeKit-CCU saving a program', () => {
  it('stores a new program without a service class from the browser', () => {
    const srv = service({ mappings: {} })
    const result = srv.saveProgram({ method: 'saveProgram', serial: 'Alles aus', name: 'Alles aus', instanceID: 'bridge-1' })
    expect(result).to.eql({ result: 'saved' })
    expect(srv.saved.programs).to.eql(['Alles aus'])
    expect(srv.saved.mappings['Alles aus:0']).to.eql({ name: 'Alles aus', instance: 'bridge-1', Service: 'HomeMaticProgramAccessory', settings: {} })
    expect(srv.messages).to.eql(['reloadApplicances'])
  })

  it('is always a program accessory, whatever class the browser sends', () => {
    const srv = service({ mappings: {} })
    srv.saveProgram({ serial: 'Alles aus', name: 'Aus', instanceID: 'bridge-1', serviceClass: 'HomeMaticSwitchAccessory' })
    expect(srv.saved.mappings['Alles aus:0'].Service).to.be('HomeMaticProgramAccessory')
  })

  it('refuses a program the CCU does not have', () => {
    const srv = service({ mappings: {} })
    expect(srv.saveProgram({ serial: 'Gibt es nicht', name: 'x', instanceID: 'bridge-1' })).to.eql({ result: 'error saving', reason: 'unknown program' })
    expect(srv.saved).to.be(undefined)
  })

  it('still refuses an unknown class for a variable', () => {
    const srv = service({ mappings: {} })
    expect(srv.saveObject({ serial: 'v', name: 'v', instanceID: 'bridge-1' }, 'variables')).to.eql({ result: 'error saving', reason: 'unknown service' })
    expect(srv.saved).to.be(undefined)
  })

  describe('dialog', () => {
    const load = () => import(pathToFileURL(path.join(__dirname, '..', 'lib', 'configurationsrv', 'html', 'js', 'saveresult.js')).href)

    it('takes only "saved" as success', async () => {
      const { saveFailure } = await load()
      expect(saveFailure({ result: 'saved' })).to.be(undefined)
      expect(saveFailure({ result: 'error saving', reason: 'unknown service' })).to.be('unknown service')
      expect(saveFailure({ error: 'unknown program' })).to.be('unknown program')
      expect(saveFailure({ result: 'error name or serial or instance not found' })).to.be('error name or serial or instance not found')
      expect(saveFailure(undefined)).to.be('no answer')
    })
  })
})
