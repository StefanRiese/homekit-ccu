'use strict'

// The language menu in the header of the settings page: Browser language (as before), English or
// Deutsch, kept per browser. English uses the texts of the page and loads no translation; it
// wrote a warning to the console for every text of the page.

const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const expect = require('expect.js')

const html = path.join(__dirname, '..', 'lib', 'configurationsrv', 'html')
const load = () => import(pathToFileURL(path.join(html, 'js', 'localization.js')).href)

describe('HomeKit-CCU language menu of the settings page', () => {
  let stored
  let reloads
  let fetched
  let warnings
  const saved = {}

  beforeEach(() => {
    stored = {}
    reloads = 0
    fetched = []
    warnings = []
    for (const key of ['window', 'document', 'navigator', 'fetch']) {
      saved[key] = Object.getOwnPropertyDescriptor(globalThis, key)
    }
    saved.warn = console.warn
    console.warn = (message) => warnings.push(message)
    const define = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
    define('window', {
      localStorage: {
        getItem: (key) => (key in stored) ? stored[key] : null,
        setItem: (key, value) => { stored[key] = String(value) }
      },
      location: { reload: () => { reloads++ } }
    })
    define('document', { documentElement: { lang: '' }, querySelectorAll: () => [] })
    define('navigator', { language: 'de-DE' })
    define('fetch', async (url) => {
      fetched.push(url)
      return { ok: true, json: async () => ({ Devices: 'Geräte' }) }
    })
  })

  afterEach(() => {
    console.warn = saved.warn
    for (const key of ['window', 'document', 'navigator', 'fetch']) {
      if (saved[key]) {
        Object.defineProperty(globalThis, key, saved[key])
      } else {
        delete globalThis[key]
      }
    }
  })

  it('keeps the choice per browser, anything else is the browser language', async () => {
    const { storedLanguage } = await load()
    expect(storedLanguage()).to.be('auto')
    stored['homekit-ccu-language'] = 'en'
    expect(storedLanguage()).to.be('en')
    stored['homekit-ccu-language'] = 'fr'
    expect(storedLanguage()).to.be('auto')
    // private mode of some browsers: no storage at all
    window.localStorage.getItem = () => { throw new Error('denied') }
    expect(storedLanguage()).to.be('auto')
  })

  it('takes the browser language without a choice, and the choice over it', async () => {
    const { Localization } = await load()
    expect(new Localization().language).to.be('de')
    expect(document.documentElement.lang).to.be('de')
    stored['homekit-ccu-language'] = 'en'
    expect(new Localization().language).to.be('en')
    expect(document.documentElement.lang).to.be('en')
  })

  it('loads the German texts for Deutsch', async () => {
    const { Localization } = await load()
    stored['homekit-ccu-language'] = 'de'
    const localizer = new Localization()
    await localizer.init()
    expect(fetched).to.eql(['./assets/de.json'])
    expect(localizer.localize('Devices')).to.be('Geräte')
  })

  it('loads nothing for English and warns about no text', async () => {
    const { Localization } = await load()
    stored['homekit-ccu-language'] = 'en'
    const localizer = new Localization()
    await localizer.init()
    expect(fetched).to.eql([])
    expect(localizer.localize('Devices')).to.be('Devices')
    expect(localizer.localize('%s lines', 12)).to.be('12 lines')
    expect(warnings).to.eql([])
  })

  it('uses the english texts without a warning for a browser language without translation', async () => {
    const { Localization } = await load()
    navigator.language = 'fr-FR'
    globalThis.fetch = async (url) => { fetched.push(url); return { ok: false } }
    const localizer = new Localization()
    await localizer.init()
    expect(fetched).to.eql(['./assets/fr.json'])
    expect(localizer.localize('Devices')).to.be('Devices')
    expect(warnings).to.eql([])
  })

  it('marks the choice in the menu and reloads the page for another one', async () => {
    const { Localization } = await load()
    stored['homekit-ccu-language'] = 'de'
    const items = ['auto', 'en', 'de'].map(value => {
      const item = { value, classes: new Set(), listeners: [] }
      item.getAttribute = () => value
      item.classList = { toggle: (name, on) => on ? item.classes.add(name) : item.classes.delete(name) }
      item.addEventListener = (type, listener) => item.listeners.push(listener)
      return item
    })
    document.querySelectorAll = (selector) => selector === '[data-language-value]' ? items : []
    new Localization().bindLanguageMenu()
    expect(items.filter(item => item.classes.has('active')).map(item => item.value)).to.eql(['de'])

    items[2].listeners.forEach(listener => listener())
    expect(reloads).to.be(0)
    items[1].listeners.forEach(listener => listener())
    expect(stored['homekit-ccu-language']).to.be('en')
    expect(reloads).to.be(1)
  })

  it('has the menu in the header and a German text for Browser language', () => {
    const page = fs.readFileSync(path.join(html, 'index.html'), 'utf8')
    for (const value of ['auto', 'en', 'de']) {
      expect(page).to.contain(`data-language-value="${value}"`)
    }
    const de = JSON.parse(fs.readFileSync(path.join(html, 'assets', 'de.json')))
    expect(de['Browser language']).to.be('Browsersprache')
    expect(fs.readFileSync(path.join(html, 'js', 'application.js'), 'utf8')).to.contain('this.localizer.bindLanguageMenu()')
  })
})
