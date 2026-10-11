'use strict'

// Every text the scripts of the settings page show through __('...') has a German translation:
// a missing one shows English on a German page (#31: messages of *Update Trigger*).

const path = require('path')
const fs = require('fs')
const expect = require('expect.js')

const html = path.join(__dirname, '..', 'lib', 'configurationsrv', 'html')

describe('HomeKit-CCU settings page translations', () => {
  it('translates every text of the page scripts into German', () => {
    const de = JSON.parse(fs.readFileSync(path.join(html, 'assets', 'de.json'), 'utf8'))
    const missing = []
    fs.readdirSync(path.join(html, 'js')).filter(file => file.endsWith('.js')).forEach(file => {
      const source = fs.readFileSync(path.join(html, 'js', file), 'utf8')
      for (const match of source.matchAll(/__\('((?:[^'\\]|\\.)*)'/g)) {
        if (de[match[1]] === undefined) missing.push(file + ': ' + match[1])
      }
    })
    expect(missing).to.eql([])
  })
})
