import fs from 'node:fs'
import path from 'node:path'

export function createWorkDocument(root, file, markdown) {
  const segments = file.replaceAll('\\', '/').replace(/^office-lab\//, '').split('/')
  const section = segments[0]
  if (!['tasks', 'docs'].includes(section) || segments.length < 2 ||
      segments.some(part => !part || part !== part.trim() || part.endsWith('.') ||
        /[<>:"|?*\x00-\x1f]|^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) ||
      !segments.at(-1).endsWith('.md') || (section === 'tasks' && segments.length !== 2)) {
    throw new Error('请填写 tasks/ 或 docs/ 下的新 Markdown 文件路径')
  }
  let directory = fs.realpathSync(root)
  for (const part of segments.slice(0, -1)) {
    directory = path.join(directory, part)
    try { fs.mkdirSync(directory) } catch (error) { if (error.code !== 'EEXIST') throw error }
    if (!fs.lstatSync(directory).isDirectory()) throw new Error('文档目录不能是链接或普通文件')
  }
  const basename = segments.at(-1)
  fs.writeFileSync(path.join(directory, basename), markdown, { flag: 'wx' })
  return 'office-lab/' + segments.join('/')
}
