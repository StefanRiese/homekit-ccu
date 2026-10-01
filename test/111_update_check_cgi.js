const path = require('path')
const fs = require('fs')
const os = require('os')
const { execFileSync, spawnSync } = require('child_process')
const expect = require('expect.js')

const CGI = path.join(__dirname, '..', 'lib', 'configurationsrv', 'html', 'update-check.cgi')

// tclsh is not available in CI, so the script is checked as text
describe('HomeKit-CCU update-check.cgi', () => {
  const script = fs.readFileSync(CGI, 'utf8')

  it('reads only cmd from the query string', () => {
    expect(script).not.to.contain('set $varname')
    expect(script).not.to.match(/\bset\s+\$/)
    expect(script).to.contain('regexp {(?:^|&)cmd=([^&]*)} $env(QUERY_STRING) -> cmd')
  })

  it('points the version check and the download at the fork', () => {
    expect(script).to.contain('set version_url "https://api.github.com/repos/bloop16/homekit-ccu/releases/latest"')
    expect(script).to.contain('set package_url "https://github.com/bloop16/homekit-ccu/releases/latest"')
  })

  it('answers only a version-shaped tag, never markup from the release json', () => {
    expect(script).to.contain('regexp {"tag_name"\\s*:\\s*"v([0-9][0-9A-Za-z.+-]*)"} $json -> newversion')
    expect(script).not.to.contain('v([^"]+)')
  })

  it('captures release tags and rejects anything else (the pattern reads the same in Tcl ARE and JS)', () => {
    const pattern = new RegExp(script.match(/regexp \{("tag_name"[^}]*)\} \$json/)[1])
    const capture = (tag) => { const m = pattern.exec(`{"url":"x","tag_name":"${tag}","name":"y"}`); return m && m[1] }
    expect(capture('v0.1.0')).to.be('0.1.0')
    expect(capture('v0.2.0-beta.1')).to.be('0.2.0-beta.1')
    expect(capture('v1.0.0+build.5')).to.be('1.0.0+build.5')
    expect(capture('v1<script>alert(1)</script>')).to.be(null)
    expect(capture('v<b>1</b>')).to.be(null)
    expect(capture('0.1.0')).to.be(null)
  })

  it('keeps the plain text answer and the download redirect', () => {
    expect(script).to.contain('$cmd == "download"')
    expect(script).to.contain('url=$package_url')
    expect(script).to.contain('puts "n/a"')
  })

  describe('the answer for the installed version', () => {
    const hasTclsh = spawnSync('tclsh', [], { input: 'exit 0' }).status === 0

    it('reads the installed version from the rc.d script, not from the request', () => {
      expect(script).to.contain('set rcd_script "/usr/local/etc/config/rc.d/homekit-ccu"')
      expect(script).to.contain('regexp -line {^VER=([0-9][0-9A-Za-z.+-]*)$} $head -> installed')
      expect(script.match(/\$env\([A-Z_]+\)/g)).to.eql(['$env(QUERY_STRING)'])
      expect(script).not.to.match(/regexp[^\n]*version=/)
    })

    describe('with tclsh', function () {
      before(function () {
        if (!hasTclsh) {
          this.skip()
        }
      })

      const logic = script.slice(script.indexOf('# --- version logic'), script.indexOf('# --- end of version logic ---'))
      const answer = (installed, release) => execFileSync('tclsh', [], { input: logic + '\nputs -nonewline [update_answer {' + installed + '} {' + release + '}]' }).toString()

      it('tells no update to an installed version that is not older than the release', () => {
        expect(answer('0.1.3', '0.1.3')).to.be('0.1.3')
        expect(answer('0.1.4-rc.1', '0.1.3')).to.be('0.1.4-rc.1')
        expect(answer('0.1.4', '0.1.3')).to.be('0.1.4')
        expect(answer('0.2.0-rc.3', '0.1.9')).to.be('0.2.0-rc.3')
        expect(answer('1.0.0', '0.9.12')).to.be('1.0.0')
      })

      it('tells the release when it is newer, also to the pre-release of it', () => {
        expect(answer('0.1.3', '0.1.4')).to.be('0.1.4')
        expect(answer('0.1.4-rc.1', '0.1.4')).to.be('0.1.4')
        expect(answer('0.1.9', '0.1.10')).to.be('0.1.10')
        expect(answer('0.9.0', '0.10.0')).to.be('0.10.0')
        expect(answer('0.1.08', '0.1.9')).to.be('0.1.9')
        expect(answer('0.1', '0.1.1')).to.be('0.1.1')
      })

      it('tells the release when the installed version is not known', () => {
        expect(answer('', '0.1.3')).to.be('0.1.3')
      })

      describe('the whole script', () => {
        let dir
        before(() => {
          dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkccu-111-'))
        })
        after(() => fs.rmSync(dir, { recursive: true, force: true }))

        // the script with a stand-in for wget (the answer of GitHub) and for the rc.d script
        function run (tag, rcd) {
          const wget = path.join(dir, 'wget')
          fs.writeFileSync(wget, '#!/bin/sh\necho \'{"url":"x","tag_name":"' + tag + '","name":"y"}\'\n', { mode: 0o755 })
          const rcdFile = path.join(dir, 'rcd')
          if (rcd === undefined) {
            fs.rmSync(rcdFile, { force: true })
          } else {
            fs.writeFileSync(rcdFile, rcd)
          }
          const patched = script.replace('/usr/bin/wget', wget).replace('/usr/local/etc/config/rc.d/homekit-ccu', rcdFile)
          expect(patched).not.to.be(script)
          const file = path.join(dir, 'check.cgi')
          fs.writeFileSync(file, patched)
          return execFileSync('tclsh', [file], { env: { QUERY_STRING: '' } }).toString().split('\r\n\r\n')[1].trim()
        }
        const rcd = (version) => '#!/bin/sh\nADDON_NAME=homekit-ccu\nVER=' + version + '\nREQUIRED_MAJOR=22\n'

        it('answers the installed version to a pre-release, the release to an older one', () => {
          expect(run('v0.1.3', rcd('0.1.4-rc.1'))).to.be('0.1.4-rc.1')
          expect(run('v0.1.4', rcd('0.1.4-rc.1'))).to.be('0.1.4')
          expect(run('v0.1.4', rcd('0.1.3'))).to.be('0.1.4')
          expect(run('v0.1.3', rcd('0.1.3'))).to.be('0.1.3')
        })

        it('answers the release without a readable rc.d script, and n/a without a release', () => {
          expect(run('v0.1.3', undefined)).to.be('0.1.3')
          expect(run('v0.1.3', 'no version here\n')).to.be('0.1.3')
          expect(run('v0.1.3', 'VER=<b>1</b>\n')).to.be('0.1.3')
          expect(run('nightly', rcd('0.1.4-rc.1'))).to.be('n/a')
        })
      })
    })
  })
})
