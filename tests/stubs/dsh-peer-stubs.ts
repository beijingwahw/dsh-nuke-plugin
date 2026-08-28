// 测试期 peer 桩：dsh-tools 的 peerDependencies（dsh-scope/dsh-llm/dsh-session）
// 在本仓库不可安装（由 harness 根环境在运行时提供）。测试经
// vitest.config.ts 的 resolve.alias 将其映射到本文件的最小桩，
// 使真实 defineTool（含 JSON Schema 参数校验）可以在测试中加载。
export class HarnessError extends Error {}
export class AnonymousEntries {}
export class NamedEntries {}
export class ScopedLayers {}
export const scopeOf = () => null
export const scopeTarget = () => null
export const assertNever = (x: never) => x
export const deepFreeze = (x: unknown) => x
export const isJsonValue = () => true
export const snapshotJsonValue = (x: unknown) => x
