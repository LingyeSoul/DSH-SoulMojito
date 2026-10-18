/**
 * Host JSONL session-persistence loader shared by the repair/verify scripts.
 *
 * DSH 0.2.0 exported the backend class as the module default:
 *   require('@deepseek-ai/dsh-session-persistence-jsonl').default
 * DSH 0.2.1-rc.2 converted the package to a plugin module and now exports only
 * `{ Config, JsonlCompressionSchema, apply, name }`; the class is private and
 * the service is created by `apply(ctx, config)`.
 *
 * Both shapes must keep working: the scripts are compatibility tools, so this
 * loader feature-detects instead of pinning a host version. The returned object
 * exposes the same `open(id, access)` surface in both eras.
 */

/**
 * Open the host persistence backend through the shape the installed host ships.
 * @param load - a `require`-compatible resolver rooted at the host install.
 * @param config - `{ root, compression }` passed to either constructor or plugin.
 * @returns the persistence service/instance owned by a private Cordis context.
 */
export async function openHostSessionPersistence(load, config) {
  const { Context } = load('@deepseek-ai/cordis')
  const { SessionStore } = load('@deepseek-ai/dsh-session')
  const persistenceModule = load('@deepseek-ai/dsh-session-persistence-jsonl')

  const context = new Context()
  new SessionStore(context)

  const Legacy = persistenceModule.JsonlSessionPersistence ?? persistenceModule.default
  if (typeof Legacy === 'function') return new Legacy(context, config)

  if (typeof persistenceModule.apply !== 'function') {
    throw new Error('installed @deepseek-ai/dsh-session-persistence-jsonl exports neither a persistence class nor a plugin apply function')
  }
  await persistenceModule.apply(context, config)
  const service = context.get('sessionPersistence')
  if (service === undefined || typeof service.open !== 'function') {
    throw new Error('host session-persistence plugin activated without providing ctx.sessionPersistence.open')
  }
  return service
}
