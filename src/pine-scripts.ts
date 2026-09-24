export type SavedPineScript = { id: string; name: string; source: string }

export const PINE_SCRIPTS_KEY = 'trading-simulator-pine-scripts'
export const PINE_DRAFT_KEY = 'trading-simulator-pine-draft'
export const PINE_SCRIPT_ID_KEY = 'trading-simulator-pine-script-id'
export const PINE_DRAFT_NAME_KEY = 'trading-simulator-pine-draft-name'
export const NEW_SCRIPT_NAME = '未命名脚本'
export const NEW_SCRIPT_SOURCE = `//@version=6\nindicator("${NEW_SCRIPT_NAME}", overlay=true)\nplot(close)`

export function savedPineScripts(): SavedPineScript[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PINE_SCRIPTS_KEY) || '[]')
    return Array.isArray(value) ? value.filter((item): item is SavedPineScript =>
      typeof item?.id === 'string' && typeof item?.name === 'string' && typeof item?.source === 'string').slice(0, 50) : []
  } catch { return [] }
}

export function selectPineScript(script: SavedPineScript | null) {
  sessionStorage.setItem(PINE_DRAFT_KEY, script?.source ?? NEW_SCRIPT_SOURCE)
  sessionStorage.setItem(PINE_DRAFT_NAME_KEY, script?.name ?? NEW_SCRIPT_NAME)
  if (script) sessionStorage.setItem(PINE_SCRIPT_ID_KEY, script.id)
  else sessionStorage.removeItem(PINE_SCRIPT_ID_KEY)
}
