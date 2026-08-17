/**
 * Copying one string, and the fallback that makes it work anyway.
 *
 * `navigator.clipboard` is unavailable on an insecure origin, and an insecure
 * origin is precisely where this panel is most likely to be read: the harness's
 * own GUI is served over plain HTTP on `127.0.0.1`, which browsers treat as
 * secure — and over plain HTTP on a LAN address, which they do not. A copy
 * button that silently did nothing there would be worse than no button, because
 * the string it copies is a pairing link somebody is about to type into a phone
 * by hand.
 *
 * So the deprecated path stays. It is the one that works.
 * @module @omdsh-plugins/omdsh-remctrl/client/clipboard
 */

/**
 * Put one string on the clipboard.
 * @param value - the text.
 * @returns whether it landed.
 */
export async function copyToClipboard(value: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
    try {
      await navigator.clipboard.writeText(value)
      return true
    } catch {
      // Denied permission, or an insecure origin that exposed the API and
      // refuses to honour it. Fall through.
    }
  }
  return legacyCopy(value)
}

/**
 * The pre-Clipboard-API path: a hidden field, a selection, and `execCommand`.
 * @param value - the text.
 * @returns whether it landed.
 */
function legacyCopy(value: string): boolean {
  if (typeof document === 'undefined') return false
  const field = document.createElement('textarea')
  field.value = value
  // Off-screen rather than `display: none`: a hidden element cannot be
  // selected, and an unselected one cannot be copied. `readOnly` stops a mobile
  // keyboard appearing for the fraction of a second it is focused.
  field.setAttribute('readonly', '')
  field.style.position = 'fixed'
  field.style.top = '-1000px'
  field.style.opacity = '0'
  document.body.appendChild(field)
  try {
    field.select()
    field.setSelectionRange(0, value.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    field.remove()
  }
}
