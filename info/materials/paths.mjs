/**
 * info/materials/paths.mjs —— 路径与 Python 探测（零依赖，只读约定）
 *
 * 数据目录解析优先级与全项目一致（见 info/paths.ps1 文件头、info/brain.mjs）：
 *   ① 环境变量 DSH_DATA（发布版/安装包用）
 *   ② 开发机旧路径（存在就用 —— 开发机上行为零变化）
 *   ③ <项目根>\端口样例（发布版样例数据）
 *
 * 索引只写在 <数据目录>\_study-core\课件库\，不碰 _study-core 下别的任何文件。
 */

import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const MATERIALS_DIR = HERE
export const PROJECT_ROOT = process.env.DSH_PROJECT_ROOT || join(HERE, '..', '..')

/** 开发机旧数据目录。与 info/paths.ps1 的 DshLegacyDataRoot 保持一致。 */
export const LEGACY_DATA_ROOT = 'AURORA_DATA'

/** 索引目录名（只新建这一个目录）。 */
export const INDEX_DIR_NAME = '课件库'

/** Chroma 子目录（只有 --engine chroma 建库时才会出现，默认不建）。 */
export const CHROMA_DIR_NAME = 'chroma'

/**
 * 解析数据根目录。不会返回“编译期猜的”路径：三个候选都没有时也如实返回候选路径，
 * 由调用方判断存在与否（索引写盘时 mkdir 会自然失败并给出明确错误）。
 * @param {string} [override] 命令行 --root 覆盖（排第 0 位，仅调试用）
 * @returns {string}
 */
export function resolveDataRoot(override) {
  if (override && override.trim()) return stripTrailingSep(override.trim())
  const fromEnv = (process.env.DSH_DATA || '').trim()
  if (fromEnv) return stripTrailingSep(fromEnv)
  if (existsSync(LEGACY_DATA_ROOT)) return stripTrailingSep(LEGACY_DATA_ROOT)
  return stripTrailingSep(join(PROJECT_ROOT, '端口样例'))
}

/** 数据根对应的 _study-core 目录。 */
export function resolveStudyCoreDir(rootOverride) {
  return join(resolveDataRoot(rootOverride), '_study-core')
}

/** 索引目录：<数据目录>\_study-core\课件库 */
export function resolveIndexDir(rootOverride) {
  return join(resolveStudyCoreDir(rootOverride), INDEX_DIR_NAME)
}

function stripTrailingSep(p) {
  return p.replace(/[\\/]+$/, '')
}

/** 可选的 Python 解释器候选（venv 优先，绝不污染系统 python）。 */
export function pythonCandidates() {
  const list = []
  for (const name of ['python.exe', 'python3.exe']) {
    const venvPython = join(MATERIALS_DIR, '.venv', 'Scripts', name)
    if (existsSync(venvPython)) list.push(venvPython)
  }
  if (process.env.DSH_PYTHON && process.env.DSH_PYTHON.trim()) list.push(process.env.DSH_PYTHON.trim())
  list.push('python')
  return [...new Set(list)]
}

const moduleProbeCache = new Map()

/**
 * 探测某个 Python 解释器能不能 import 某个模块。
 * @param {string} python 解释器路径或命令名
 * @param {string} module 模块名（如 fitz / chromadb）
 * @returns {boolean}
 */
export function probePythonModule(python, module) {
  const key = `${python}::${module}`
  if (moduleProbeCache.has(key)) return moduleProbeCache.get(key)
  // 模块名只允许 [A-Za-z0-9_.]，杜绝把参数拼进 -c 的注入面
  if (!/^[A-Za-z0-9_.]+$/.test(module)) {
    moduleProbeCache.set(key, false)
    return false
  }
  const result = spawnSync(python, ['-c', `import ${module}`], {
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  })
  const ok = result.status === 0
  moduleProbeCache.set(key, ok)
  return ok
}

/**
 * 找一个能 import 指定模块的 Python。找不到返回 null（调用方据此降级并明确报原因）。
 * @param {string} module
 * @returns {{ python: string } | null}
 */
export function findPythonWith(module) {
  for (const python of pythonCandidates()) {
    if (probePythonModule(python, module)) return { python }
  }
  return null
}

/** PowerShell 下打印中文是否乱码与本模块无关；这里只提供统一的“截断”工具。 */
export function preview(text, max = 20) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
