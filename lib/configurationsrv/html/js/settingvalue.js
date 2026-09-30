/*
 * The value a number setting shows in the form: the stored one, also 0, else the default. A
 * stored 0 was taken for "not set" and shown (and saved again) as the default.
 */
export function numberSetting (stored, fallback) {
  const value = parseInt(stored, 10)
  return Number.isFinite(value) ? value : parseInt(fallback, 10)
}

/**
 * Stores the default of a setting that was never stored, so the dialog saves it. A stored 0,
 * false or '' is a value and stays: the dialog of variables and programs took it for "not set"
 * and saved the default instead.
 */
export function fillDefault (settings, key, fallback) {
  if ((settings[key] === undefined) && (fallback !== undefined)) {
    settings[key] = fallback
  }
}
