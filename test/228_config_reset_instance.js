'use strict'

// "Reset instance" sent the reset to the main process but never answered the page: the request
// stayed open, and the page refreshed the bridge list only after the answer, so never.

const path = require('path')
const expect = require('expect.js')
const ConfigurationService = require(path.join(__dirname, '..', 'lib', 'configurationsrv', 'ConfigurationService.js'))

describe('HomeKit-CCU ConfigurationService API resetInstance', () => {
  const callApi = async (query) => {
    // bypass the constructor: it reads the real settings from UIX_CONFIG_PATH
    const service = Object.create(ConfigurationService.prototype)
    service.log = { error () {}, warn () {}, info () {}, debug () {} }
    service.useAuth = false
    service.bridges = [{ id: 'bridge-1', displayName: 'HomeKit-CCU' }]
    const sent = []
    service.process = { send: (message) => sent.push(message) }
    const response = {
      headersSent: false,
      writeHead () { this.headersSent = true },
      end (body) { this.ended = true; this.body = body }
    }
    await service.processApiCall(query, response)
    return { response, sent }
  }

  it('answers once the reset is sent to the main process', async () => {
    const { response, sent } = await callApi({ method: 'resetInstance', uuid: 'bridge-1' })
    expect(response.ended).to.be(true)
    expect(JSON.parse(response.body)).to.eql({ result: 'reset' })
    expect(sent).to.eql([{ topic: 'resetPairing', uuid: 'bridge-1' }])
  })

  it('answers that an unknown bridge was not found, and resets nothing', async () => {
    const { response, sent } = await callApi({ method: 'resetInstance', uuid: 'unknown' })
    expect(response.ended).to.be(true)
    expect(JSON.parse(response.body)).to.eql({ result: 'bridge not found' })
    expect(sent).to.eql([])
  })
})
