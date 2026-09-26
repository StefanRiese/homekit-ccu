/*
 * The answer of the configuration service to a save request: undefined when it was saved,
 * otherwise the reason it was not (a key of the localization where there is one).
 */
export function saveFailure (result) {
  if ((result === undefined) || (result === null)) {
    return 'no answer'
  }
  if (result.result === 'saved') {
    return undefined
  }
  return result.reason || result.error || result.result || 'no answer'
}
