/*
 * The log on the settings page: the end of the log (1000 lines, of the levels switched on), then every few seconds the lines written
 * since (api call logTail, which reads from the end of the file). Errors and warnings are
 * marked, the levels can be switched off and the lines searched. The colours are those of
 * Bootstrap, so they follow the light and the dark mode (css/application.css, .log-view).
 */

import { LEVELS, annotate, matches, searchMatcher, stampOf } from './logformat.js'

const POLL_MS = 2500
// lines kept in the view; older ones are dropped
const MAX_LINES = 2000
// how close to the end the view counts as following the log
const FOLLOW_PX = 40
// the view is never lower than this (a small window scrolls the page instead)
const MIN_HEIGHT_PX = 256

const LEVEL_BUTTONS = {
  error: { label: 'Errors', style: 'danger' },
  warn: { label: 'Warnings', style: 'warning' },
  info: { label: 'Info', style: 'secondary' },
  debug: { label: 'Debug', style: 'info' }
}

export class LogView {
  constructor (application) {
    this.application = application
    this.entries = []
    this.levels = new Set(LEVELS)
    this.search = ''
    this.regex = false
    this.matcher = searchMatcher('')
    this.paused = false
    this.running = false
    // one number per showing: an answer to an earlier one is dropped
    this.session = 0
  }

  __ () {
    return this.application.__.apply(this.application, arguments)
  }

  /** shows the view in the main card and starts following the log */
  show () {
    this.stop()
    this.reset()
    this.render()
    this.fitHeight()
    if (!this.resizeBound) {
      this.resizeBound = true
      window.addEventListener('resize', () => {
        if (this.running) {
          this.fitHeight()
        }
      })
    }
    this.running = true
    this.poll()
  }

  // the view takes the height left in the window, so the page needs no scrolling: the window
  // minus what is above the view (header, tiles, toolbar) and below it (footer of the card and
  // of the page); the free space of the page (.app-content grows) does not count
  fitHeight () {
    const el = this.view && this.view[0]
    if (!el || !el.isConnected) {
      return
    }
    const view = el.getBoundingClientRect()
    const card = el.closest('.main-card')
    const content = el.closest('.app-content')
    const footer = document.querySelector('.app-footer')
    let below = card ? card.getBoundingClientRect().bottom - view.bottom : 0
    if (content) {
      below += parseFloat(window.getComputedStyle(content).paddingBottom) || 0
    }
    if (footer) {
      below += footer.offsetHeight
    }
    const top = view.top + window.scrollY
    el.style.height = Math.max(MIN_HEIGHT_PX, Math.floor(window.innerHeight - top - below)) + 'px'
  }

  // the end of the log anew, with the levels switched on now
  reload () {
    this.reset()
    this.view.children('.log-line').remove()
    this.empty.text(this.__('Loading the log ...')).show()
    this.showStatus()
    this.poll()
  }

  reset () {
    this.session++
    this.entries = []
    this.offset = undefined
    this.file = undefined
    this.last = undefined
    this.since = undefined
  }

  /** stops following the log (another page is shown) */
  stop () {
    this.running = false
    clearTimeout(this.timer)
  }

  render () {
    const container = $('#container')
    const footer = $('#container_footer')
    container.empty()
    footer.empty()

    const toolbar = $('<div>').addClass('log-toolbar d-flex flex-wrap align-items-center gap-2 mb-2')
    const group = $('<div>').addClass('btn-group btn-group-sm').attr('role', 'group').attr('aria-label', this.__('Levels'))
    LEVELS.forEach(level => {
      const id = 'log_level_' + level
      const input = $('<input>').attr({ type: 'checkbox', id, autocomplete: 'off' }).addClass('btn-check')
        .prop('checked', this.levels.has(level))
        .on('change', () => {
          if (input.prop('checked')) {
            this.levels.add(level)
          } else {
            this.levels.delete(level)
          }
          // the server filters the levels and reads further back for them (a log full of debug lines)
          this.reload()
        })
      const button = LEVEL_BUTTONS[level]
      group.append(input, $('<label>').addClass('btn btn-outline-' + button.style).attr('for', id).text(this.__(button.label)))
    })

    const search = $('<input>').attr({ type: 'search', placeholder: this.__('Search'), 'aria-label': this.__('Search') })
      .addClass('form-control log-search')
      .val(this.search)
      .on('input', () => {
        this.search = search.val()
        this.applySearch()
      })
    // the search as regular expression; one that is no valid one marks the field and filters nothing
    const regex = $('<input>').attr({ type: 'checkbox', id: 'log_regex', autocomplete: 'off' }).addClass('btn-check')
      .prop('checked', this.regex)
      .on('change', () => {
        this.regex = regex.prop('checked')
        this.applySearch()
      })
    const regexLabel = $('<label>').addClass('btn btn-outline-secondary font-monospace').attr({ for: 'log_regex', title: this.__('Regular expression') })
      .text('.*')
    this.searchField = search.toggleClass('is-invalid', !this.matcher.valid)
    const searchGroup = $('<div>').addClass('input-group input-group-sm log-search-group')
      .append(search, regex, regexLabel)

    const pause = $('<div>').addClass('form-check form-switch mb-0')
    const pauseInput = $('<input>').attr({ type: 'checkbox', id: 'log_pause', role: 'switch' }).addClass('form-check-input')
      .prop('checked', this.paused)
      .on('change', () => {
        this.paused = pauseInput.prop('checked')
        if (!this.paused) {
          this.poll()
        }
        this.showStatus()
      })
    pause.append(pauseInput, $('<label>').addClass('form-check-label').attr('for', 'log_pause').text(this.__('Pause')))

    this.status = $('<span>').addClass('small text-body-secondary ms-sm-auto log-status')
    toolbar.append(group, searchGroup, pause, this.status)

    this.view = $('<div>').addClass('log-view').attr({ role: 'log', tabindex: '0', 'aria-label': this.__('Log') })
    this.empty = $('<div>').addClass('log-empty text-body-secondary').text(this.__('Loading the log ...'))
    this.view.append(this.empty)
    container.append(toolbar, this.view)

    const download = $('<button>').attr('type', 'button').addClass('btn btn-sm btn-outline-secondary')
      .append($('<i>').addClass('bi bi-download me-1'), $('<span>').text(this.__('Download Log')))
      .on('click', () => this.application.download({ method: 'getLog' }))
    footer.append($('<div>').addClass('d-flex flex-wrap align-items-center justify-content-between gap-2')
      .append($('<span>').addClass('small text-body-secondary').text(this.__('Debug lines are only written while debug is enabled.')), download))
  }

  async poll () {
    clearTimeout(this.timer)
    if (!this.running || this.paused || this.requesting) {
      return
    }
    const session = this.session
    // nothing is fetched while the page is in the background
    if (!document.hidden) {
      try {
        const query = { method: 'logTail' }
        if (this.levels.size < LEVELS.length) {
          query.levels = LEVELS.filter(level => this.levels.has(level)).join(',')
        }
        if (this.offset !== undefined) {
          query.offset = this.offset
          query.file = this.file
          query.last = this.last
        }
        this.requesting = true
        let result
        try {
          result = await this.application.makeApiRequest(query)
        } finally {
          this.requesting = false
        }
        if (session !== this.session) {
          // shown anew meanwhile: that showing starts with the end of the log
          this.poll()
          return
        }
        if (!this.running) {
          return
        }
        this.failed = false
        this.receive(result || {})
      } catch (e) {
        if (session !== this.session) {
          this.poll()
          return
        }
        if (e && e.status === 401) {
          this.application.checkPermissionFromError(e)
          this.stop()
          return
        }
        this.failed = true
      }
      this.showStatus()
    }
    this.timer = setTimeout(() => this.poll(), POLL_MS)
  }

  receive (result) {
    const first = this.offset === undefined
    if (result.reset && !first) {
      this.addMarker(this.__('The log was started anew.'))
    } else if (result.skipped) {
      this.addMarker(this.__('Some lines are left out: more was written than the view takes at once.'))
    }
    this.offset = result.offset
    this.file = result.file
    this.last = result.last
    if (first || result.reset) {
      this.since = result.since
    }
    this.updated = new Date()
    const lines = result.lines || []
    // the server gives the level of each line; an older one only the lines
    const entries = Array.isArray(result.lineLevels) && result.lineLevels.length === lines.length
      ? lines.map((text, i) => ({ text, level: result.lineLevels[i] }))
      : annotate(lines, this.entries.length ? this.entries[this.entries.length - 1].level : 'info')
    this.append(entries)
    if (first) {
      this.scrollToEnd()
    }
  }

  addMarker (text) {
    this.append([{ text: '— ' + text + ' —', level: 'marker' }])
  }

  append (entries) {
    if (entries.length === 0) {
      this.showEmpty()
      return
    }
    const following = this.isFollowing()
    this.entries.push(...entries)
    const dropped = this.entries.length - MAX_LINES
    if (dropped > 0) {
      this.entries.splice(0, dropped).forEach(entry => entry.element && entry.element.remove())
      // the view now goes back to its oldest line
      this.since = stampOf(this.entries.map(entry => entry.text)) || this.since
    }
    this.view.append(entries.filter(entry => this.isShown(entry)).map(entry => this.lineFor(entry)))
    this.showEmpty()
    if (following) {
      this.scrollToEnd()
    }
  }

  applySearch () {
    this.matcher = searchMatcher(this.search, this.regex)
    this.searchField.toggleClass('is-invalid', !this.matcher.valid)
      .attr('title', this.matcher.valid ? null : this.__('This is no valid regular expression.'))
    this.redraw()
  }

  isShown (entry) {
    return (entry.level === 'marker') || matches(entry, this.levels, this.matcher)
  }

  // every line of the log is a line of the view, as text (never as markup)
  lineFor (entry) {
    entry.element = $('<div>').addClass('log-line log-' + entry.level).text(entry.text)
    return entry.element
  }

  redraw () {
    this.view.children('.log-line').remove()
    this.entries.forEach(entry => { entry.element = undefined })
    this.view.append(this.entries.filter(entry => this.isShown(entry)).map(entry => this.lineFor(entry)))
    this.showEmpty()
    this.scrollToEnd()
  }

  showEmpty () {
    const lines = this.view.children('.log-line').length
    if (lines > 0) {
      this.empty.hide()
    } else {
      this.empty.text(this.entries.length ? this.__('No line matches the filter.') : this.__('The log is empty.')).show()
    }
  }

  isFollowing () {
    const el = this.view[0]
    return el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_PX
  }

  scrollToEnd () {
    const el = this.view[0]
    el.scrollTop = el.scrollHeight
  }

  showStatus () {
    if (!this.status) {
      return
    }
    const parts = [this.__('%s lines', this.entries.filter(entry => entry.level !== 'marker').length)]
    if (this.since) {
      // how far back the view (and so the search) goes
      parts.push(this.__('from %s', this.since))
    }
    if (this.failed) {
      parts.push(this.__('The log could not be read, trying again ...'))
    } else if (this.paused) {
      parts.push(this.__('paused'))
    } else if (this.updated) {
      parts.push(this.__('updated %s', this.updated.toLocaleTimeString()))
    }
    this.status.text(parts.join(' · '))
  }
}
