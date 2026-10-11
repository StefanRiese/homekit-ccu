'use strict'

// After a start, Apple Home reads every value while Rega (one script at a time) reads the
// databases and the values of all devices. A thermostat whose values were not known yet asked
// Rega three times one after the other and waited behind all of that: hap-nodejs logged "didn't
// respond at all" and Apple Home showed "No Response". The reads and commands of Apple Home now
// go before the background work in the Rega queue.

const http = require('http')
const path = require('path')
const expect = require('expect.js')
const Rega = require(path.join(__dirname, '..', 'lib', 'HomeMaticRegaRequest.js'))
const { recordingLog } = require(path.join(__dirname, 'helpers', 'recordingLog.js'))

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

describe('HomeKit-CCU Rega queue: Apple Home before background work', () => {
  let server
  let received
  before(done => {
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        received.push(body)
        // the first script runs a while, as the database scripts do
        setTimeout(() => res.end(body + '<xml><exec></exec></xml>'), received.length === 1 ? 100 : 5)
      })
    })
    server.listen(0, '127.0.0.1', done)
  })
  after(done => server.close(done))
  beforeEach(() => { received = [] })

  const rega = (tag, background) => {
    const r = new Rega(recordingLog(), '127.0.0.1', tag, 2)
    r.port = server.address().port
    r.background = background
    return r
  }

  it('runs a read of Apple Home before the background work waiting, after the running script', async () => {
    const running = rega('fetchVariables', true).script('database 1', 0)
    await wait(20)
    const waiting = [
      rega('fetchPrograms', true).script('database 2', 0),
      rega('fetchRooms', true).script('database 3', 0),
      rega('getValue', false).script('read of Apple Home', 0),
      rega('setValue', false).script('command of Apple Home', 0)
    ]
    await Promise.all([running, ...waiting])
    expect(received).to.eql(['database 1', 'read of Apple Home', 'command of Apple Home', 'database 2', 'database 3'])
  })

  it('keeps the order of requests of the same kind', async () => {
    await Promise.all(['a', 'b', 'c'].map(name => rega('getValue', false).script(name, 0)))
    expect(received).to.eql(['a', 'b', 'c'])
  })

  // the start read of the values waits for the setup of the accessories: a datapoint that asks Rega
  // whether it exists asks again for the next one as soon as the answer is there (#28)
  it('settles after the waiting requests, also those that follow each other, without a script', async () => {
    const running = rega('fetchVariables', true).script('database', 0)
    await wait(20)
    const chain = rega('hazDatapoint', false).script('exists 1', 0)
      .then(() => rega('hazDatapoint', false).script('exists 2', 0))
    await Rega.afterWaitingRequests()
    expect(received).to.eql(['database', 'exists 1', 'exists 2'])
    await Promise.all([running, chain])
  })

  it('keeps the order of the background work', async () => {
    await Promise.all(['a', 'b', 'c'].map(name => rega('fetchDatabase', true).script(name, 0)))
    expect(received).to.eql(['a', 'b', 'c'])
  })
})
