'use strict'

// The value a number setting shows in the settings form: a stored 0 was shown (and saved again)
// as the default, e.g. "Read the picture again after" 0 as 10.

const path = require('path')
const { pathToFileURL } = require('url')
const expect = require('expect.js')

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'lib', 'configurationsrv', 'html', 'js', 'settingvalue.js')).href)

describe('HomeKit-CCU number settings in the form', () => {
  it('shows a stored 0 as 0, not as the default', async () => {
    const { numberSetting } = await load()
    expect(numberSetting(0, 10)).to.be(0)
    expect(numberSetting('0', 10)).to.be(0)
  })

  it('shows other stored values, and the default when nothing usable is stored', async () => {
    const { numberSetting } = await load()
    expect(numberSetting(1, 10)).to.be(1)
    expect(numberSetting('30', 10)).to.be(30)
    expect(numberSetting(undefined, 10)).to.be(10)
    expect(numberSetting(null, '10')).to.be(10)
    expect(numberSetting('', 10)).to.be(10)
    expect(numberSetting(NaN, 10)).to.be(10)
  })
})
