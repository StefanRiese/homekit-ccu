'use strict'

// "Enable Debug" on the settings page showed no change until the page was reloaded. The api call
// sent the switch to the main process and pushed the system info to the page at once, before the
// main process had switched the debug mode and answered (IPC topic 'debug'): the page got the old
// mode, and the next push came 180 s later. Each click also started another 180 s push loop.

const path = require('path')
const expect = require('expect.js')
const ConfigurationService = require(path.join(__dirname, '..', 'lib', 'configurationsrv', 'ConfigurationService.js'))

describe('HomeKit-CCU ConfigurationService debug button', () => {
  let service
  let pushed
  let sent
  let debug

  beforeEach(() => {
    // bypass the constructor: it reads the real settings from UIX_CONFIG_PATH
    service = Object.create(ConfigurationService.prototype)
    debug = false
    service.log = {
      error () {},
      warn () {},
      info () {},
      debug () {},
      isDebugEnabled: () => debug,
      setDebugEnabled: (enabled) => { debug = enabled }
    }
    service.useAuth = false
    service.fetchVersion = () => 'test'
    pushed = []
    // one open page
    service.events = { prune () {}, size: 1, broadcast: (message) => pushed.push(message) }
    sent = []
    service.process = { send: (message) => sent.push(message) }
  })

  const callApi = async (query) => {
    const response = { headersSent: false, writeHead () { this.headersSent = true }, end (body) { this.body = body } }
    await service.processApiCall(query, response)
    return JSON.parse(response.body)
  }

  const settle = () => new Promise(resolve => setImmediate(resolve))

  it('sends the new debug mode to the page once the main process switched it', async () => {
    expect(await callApi({ method: 'debug', enable: 'true' })).to.eql({ response: 'ok' })
    expect(sent).to.eql([{ topic: 'debug', debug: true }])
    await settle()
    // nothing with the old mode in between
    expect(pushed).to.eql([])

    // the main process switched it and answers
    service.handleIncommingIPCMessage({ topic: 'debug', debug: true })
    await settle()
    expect(pushed.map(m => [m.message, m.payload.debug])).to.eql([['heartbeat', true]])

    await callApi({ method: 'debug', enable: 'false' })
    service.handleIncommingIPCMessage({ topic: 'debug', debug: false })
    await settle()
    expect(pushed.map(m => m.payload.debug)).to.eql([true, false])
  })

  it('pushes nothing when no page is open', async () => {
    service.events.size = 0
    service.handleIncommingIPCMessage({ topic: 'debug', debug: true })
    await settle()
    expect(pushed).to.eql([])
    expect(debug).to.be(true)
  })
})
