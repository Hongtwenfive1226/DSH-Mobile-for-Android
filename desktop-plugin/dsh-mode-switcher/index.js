/**
 * Node half of the persistent mode-switcher plugin. The empty apply exists so
 * the package appears in the host Loader; the browser half ships the session
 * header button through exports["./client"], discovered from the package.json
 * dsh.client declaration (mirrors dsh-client-ui-agent-preset's node half).
 */
export function apply() {}
