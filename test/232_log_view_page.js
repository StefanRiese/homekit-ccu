'use strict'

// The log view of the settings page (js/logview.js): the level of each line, the filter, and
// that every text of the view has a German translation.

const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const expect = require('expect.js')

const html = path.join(__dirname, '..', 'lib', 'configurationsrv', 'html')
const load = () => import(pathToFileURL(path.join(html, 'js', 'logformat.js')).href)

describe('HomeKit-CCU log view of the settings page', () => {
  it('takes the level of a line from the log, a line of the rc.d script as info', async () => {
    const { levelOf } = await load()
    expect(levelOf('[10/2/2026, 7:39:45 AM] error - [HAP ConfigServer] [Config] restore failed')).to.be('error')
    expect(levelOf('[10/2/2026, 7:35:15 AM] warn - [HAP Server] [Server] bridge HomeKit-CCU: ...')).to.be('warn')
    expect(levelOf('[10/2/2026, 8:09:06 AM] debug - [HAP Server] [RPC] event for HmIP-RF.CENTRAL:0.PONG')).to.be('debug')
    expect(levelOf('[10/2/2026, 7:35:12 AM] info - [HAP Server] [CCU] device database loaded 29 devices found')).to.be('info')
    expect(levelOf('[10/02/2026, 7:34:45 AM] [HomeKit-CCU] [install] Running install and start in background')).to.be('info')
  })

  it('gives the rest of a stack trace the level of its line', async () => {
    const { annotate } = await load()
    const entries = annotate([
      '[10/2/2026, 7:00:00 AM] error - [HAP Server] TypeError: x is undefined',
      '    at Server.reload (/usr/local/addons/homekit-ccu/node_modules/homekit-ccu/lib/Server.js:12:3)',
      '[10/2/2026, 7:00:01 AM] info - [HAP Server] next'
    ])
    expect(entries.map(e => e.level)).to.eql(['error', 'error', 'info'])
    // the first line of a batch may continue the last of the one before
    expect(annotate(['    at foo (bar.js:1:1)'], 'warn')[0].level).to.be('warn')
  })

  it('filters by level and search text, in any case', async () => {
    const { matches } = await load()
    const entry = { text: '[10/2/2026, 7:35:15 AM] warn - Balkonkraftwerk_Leistung > Current Ambient Light Level', level: 'warn' }
    expect(matches(entry, new Set(['error', 'warn']), '')).to.be(true)
    expect(matches(entry, new Set(['error']), '')).to.be(false)
    expect(matches(entry, new Set(['warn']), 'balkon')).to.be(true)
    expect(matches(entry, new Set(['warn']), '  AMBIENT ')).to.be(true)
    expect(matches(entry, new Set(['warn']), 'Küche')).to.be(false)
  })

  it('searches as regular expression with the button, in any case', async () => {
    const { searchMatcher, matches } = await load()
    const levels = new Set(['info', 'warn'])
    const line = { text: '[10/2/2026, 8:07:39 AM] info - [HAP Server] [RPC] interface HmIP-RF. is connected', level: 'info' }
    expect(matches(line, levels, searchMatcher('hmip-rf\\. is', true))).to.be(true)
    expect(matches(line, levels, searchMatcher('interface (BidCos|HmIP)-RF', true))).to.be(true)
    expect(matches(line, levels, searchMatcher('^\\[10/2/2026, 8:07:\\d\\d AM\\] info', true))).to.be(true)
    expect(matches(line, levels, searchMatcher('BidCos-RF', true))).to.be(false)
    // without the button the same text is searched as it is
    expect(matches(line, levels, searchMatcher('(BidCos|HmIP)-RF', false))).to.be(false)
    expect(matches(line, levels, searchMatcher('HmIP-RF. is', false))).to.be(true)
  })

  it('marks an expression that is no valid one and filters nothing with it', async () => {
    const { searchMatcher } = await load()
    const invalid = searchMatcher('interface (HmIP', true)
    expect(invalid.valid).to.be(false)
    expect(invalid.test('anything')).to.be(true)
    // as text the same input is fine
    expect(searchMatcher('interface (HmIP', false).valid).to.be(true)
    expect(searchMatcher('   ', true).valid).to.be(true)
  })

  it('has a German text for every text of the view and its menu entry', () => {
    const de = JSON.parse(fs.readFileSync(path.join(html, 'assets', 'de.json')))
    const source = fs.readFileSync(path.join(html, 'js', 'logview.js'), 'utf8')
    const texts = [...source.matchAll(/__\('([^']+)'/g)].map(m => m[1])
    // the labels of the level buttons
    texts.push(...[...source.matchAll(/label: '([^']+)'/g)].map(m => m[1]))
    texts.push('Show log', 'Log')
    expect(texts.length).to.be.greaterThan(15)
    expect(texts.filter(text => de[text] === undefined)).to.eql([])
    expect(fs.readFileSync(path.join(html, 'index.html'), 'utf8')).to.contain('id="showLog"')
  })

  it('shows every line as text, never as markup', () => {
    const source = fs.readFileSync(path.join(html, 'js', 'logview.js'), 'utf8')
    expect(source).to.contain(".addClass('log-line log-' + entry.level).text(entry.text)")
    expect(source).not.to.match(/\.html\(entry/)
  })

  it('uses only theme colours of Bootstrap for the view', () => {
    const css = fs.readFileSync(path.join(html, 'css', 'application.css'), 'utf8')
    const block = css.slice(css.indexOf('/* ---- log view'))
    expect(block).to.contain('var(--bs-danger-text-emphasis)')
    // no fixed colour that would only fit the light or the dark mode
    expect(block).not.to.match(/#[0-9a-fA-F]{3,6}\b|rgb\(/)
  })
})
