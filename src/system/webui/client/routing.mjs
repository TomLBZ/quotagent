/** Only a contributing page can choose which context belongs in a shareable URL. */
export function linkContext(context, contribution = {}) {
  const selected = {}
  for (const key of contribution.linkKeys || []) {
    const value = context?.[key]
    if (value !== undefined && value !== null && value !== '') selected[key] = value
  }
  return JSON.parse(JSON.stringify(selected))
}
export function routeHash(page, context = {}, contribution = {}) {
  const selected = linkContext(context, contribution)
  return '#' + encodeURIComponent(page || '') + (Object.keys(selected).length ? '?context=' + encodeURIComponent(JSON.stringify(selected)) : '')
}
export function readRoute(hash, pages) {
  try {
    const raw = String(hash || '').replace(/^#/, ''), index = raw.indexOf('?')
    const page = decodeURIComponent(index < 0 ? raw : raw.slice(0, index))
    const query = new URLSearchParams(index < 0 ? '' : raw.slice(index + 1))
    const supplied = JSON.parse(query.get('context') || '{}')
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw new Error('Invalid link context')
    return {page, context:linkContext(supplied, pages.get(page))}
  } catch { return {page:'', context:{}, error:'This workspace link is incomplete or unreadable.'} }
}
export function matchesShortcut(event, shortcut) {
  const parts = String(shortcut || '').toLowerCase().split('+'), key = parts.pop()
  return event.key.toLowerCase() === key && !!(event.ctrlKey || event.metaKey) === parts.includes('mod')
    && event.altKey === parts.includes('alt') && event.shiftKey === parts.includes('shift')
}
