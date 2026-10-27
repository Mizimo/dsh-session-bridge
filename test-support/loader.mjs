const stubs = new Map([
  ['@deepseek-ai/dsh-agent', new URL('./stubs/dsh-agent.mjs', import.meta.url).href],
  ['@deepseek-ai/dsh-llm', new URL('./stubs/dsh-llm.mjs', import.meta.url).href],
  ['@deepseek-ai/dsh-tools', new URL('./stubs/dsh-tools.mjs', import.meta.url).href],
])

export function resolve(specifier, context, next) {
  const url = stubs.get(specifier)
  if (url !== undefined) return { url, shortCircuit: true }
  return next(specifier, context)
}
