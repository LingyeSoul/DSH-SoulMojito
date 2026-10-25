// Shared message factory for the plugin server half.

export function createMessage<T extends object>(input: T): Readonly<T & { id: string }> {
  return deepFreeze(structuredClone({ ...input, id: crypto.randomUUID() }))
}

export function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>()
  const pending: unknown[] = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === null || typeof current !== 'object' || seen.has(current)) continue
    seen.add(current)
    Object.freeze(current)
    pending.push(...Object.values(current))
  }
  return value
}
