'use strict'

// The values of settings in the settings forms: a stored 0 was shown (and saved again) as the
// default, e.g. "Read the picture again after" 0 as 10, and the dialog of variables and programs
// replaced a stored 0 or false with the default when it was saved.

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

  it('keeps a stored 0, false or empty text when the default is filled in', async () => {
    const { fillDefault } = await load()
    // e.g. the alarm variable: AWAY_ARM 0 (default 1), a checkbox off whose default is on
    const settings = { AWAY_ARM: 0, notify: false, label: '' }
    fillDefault(settings, 'AWAY_ARM', 1)
    fillDefault(settings, 'notify', true)
    fillDefault(settings, 'label', 'Alarm')
    expect(settings).to.eql({ AWAY_ARM: 0, notify: false, label: '' })
  })

  it('fills the default of a setting that was never stored, and nothing without a default', async () => {
    const { fillDefault } = await load()
    const settings = {}
    fillDefault(settings, 'AWAY_ARM', 1)
    fillDefault(settings, 'DISARMED', 0)
    fillDefault(settings, 'note', undefined)
    expect(settings).to.eql({ AWAY_ARM: 1, DISARMED: 0 })
    expect('note' in settings).to.be(false)
  })
})
