/*
 * The value a number setting shows in the form: the stored one, also 0, else the default. A
 * stored 0 was taken for "not set" and shown (and saved again) as the default.
 */
export function numberSetting (stored, fallback) {
  const value = parseInt(stored, 10)
  return Number.isFinite(value) ? value : parseInt(fallback, 10)
}
