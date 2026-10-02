/*
 * The lines of the log view: the level of each line and the filter of the view. Without the page
 * (no jQuery, no DOM), so the tests can load it.
 */

export const LEVELS = ['error', 'warn', 'info', 'debug']

// "[10/2/2026, 8:07:38 AM] info - [HAP Server] ..."; the lines of the rc.d script
// ("[10/02/2026, 7:34:45 AM] [HomeKit-CCU] [install] ...") have no level and count as info
const LEVEL = /^\[[^\]]*\] (error|warn|info|debug) - /
const STAMPED = /^\[\d{1,2}\/\d{1,2}\/\d{4},/

/**
 * The level of a line; a line without a time stamp (the rest of a stack trace or of an object
 * written over several lines) belongs to the line before.
 */
export function levelOf (line, previous = 'info') {
  const match = LEVEL.exec(line)
  if (match) {
    return match[1]
  }
  return STAMPED.test(line) ? 'info' : previous
}

/** the lines with their level, `previous` the level of the line before the first */
export function annotate (lines, previous = 'info') {
  let level = previous
  return lines.map(text => {
    level = levelOf(text, level)
    return { text, level }
  })
}

/** whether a line is shown with the levels switched on and the search text (any case) */
export function matches (entry, levels, search) {
  if (!levels.has(entry.level)) {
    return false
  }
  const term = (search || '').trim().toLowerCase()
  return (term === '') || entry.text.toLowerCase().includes(term)
}
