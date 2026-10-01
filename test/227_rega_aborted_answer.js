'use strict'

// Rega runs one script at a time, so all requests wait in one queue. A connection that dropped in
// the middle of an answer settled the request never (Node 22 reports it as error 'aborted' of the
// answer, Node 18 only closes it): the queue waited forever and switching, variables and programs
// hung until the add-on was restarted.

const http = require('http')
const path = require('path')
const expect = require('expect.js')
const Rega = require(path.join(__dirname, '..', 'lib', 'HomeMaticRegaRequest.js'))
const { recordingLog } = require(path.join(__dirname, 'helpers', 'recordingLog.js'))

describe('HomeKit-CCU Rega answer cut off', () => {
  let server
  let served
  let abortFirst

  before(done => {
    server = http.createServer((req, res) => {
      served++
      req.resume()
      req.on('end', () => {
        if (served <= abortFirst) {
          // promises 1000 bytes, sends a few and drops the connection
          res.writeHead(200, { 'Content-Length': 1000 })
          res.write('{"devic')
          setTimeout(() => res.socket.destroy(), 20)
        } else {
          res.end('Pong<xml><exec></exec></xml>')
        }
      })
    })
    server.listen(0, '127.0.0.1', done)
  })
  after(done => server.close(done))
  beforeEach(() => { served = 0 })

  const rega = () => {
    const r = new Rega(recordingLog(), '127.0.0.1', 'test', 2)
    r.port = server.address().port
    return r
  }

  it('fails a cut off answer, and the next request is served', async () => {
    abortFirst = 1
    let error
    await rega().script('Write("a");', 0).catch(e => { error = e })
    expect(error.message).to.match(/aborted/)
    expect(await rega().script('Write("Pong");', 0)).to.be('Pong')
    expect(served).to.be(2)
  })

  it('tries a cut off answer again', async () => {
    abortFirst = 1
    expect(await rega().script('Write("Pong");', 1, 0)).to.be('Pong')
    expect(served).to.be(2)
  })
})
