interface PluginLoadError {
  plugin?: unknown;
  type?: unknown;
  message?: unknown;
  path?: unknown;
}

/**
 * Context-audit warnings for the `plugin_errors` that Claude Code 2.1.283+
 * reports on system/init: a plugin that did not load, or loaded without one
 * of its components. `path` names the plugin directory HappyClaw mounted.
 */
export function pluginLoadWarnings(initMessage: unknown): string[] {
  const errors = (initMessage as { plugin_errors?: unknown } | null)
    ?.plugin_errors;
  if (!Array.isArray(errors)) return [];
  return errors.flatMap((raw: PluginLoadError) => {
    if (!raw || typeof raw !== 'object') return [];
    const plugin = typeof raw.plugin === 'string' ? raw.plugin : 'plugin';
    const type = typeof raw.type === 'string' ? raw.type : 'generic-error';
    const message =
      typeof raw.message === 'string' ? raw.message.slice(0, 300) : '';
    const location = typeof raw.path === 'string' ? ` (${raw.path})` : '';
    return [
      `plugin ${plugin}${location} failed to load: ${type}${message ? ` - ${message}` : ''}`,
    ];
  });
}
