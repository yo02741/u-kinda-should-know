// 深入內容的字數：第一個停靠點之前是「必讀」，之後是「選讀」。字數不含程式碼區塊與 Markdown 符號。
//   node scripts/deep-stats.mjs            每條路線的中位數，加上必讀超過預算的主線課
//   node scripts/deep-stats.mjs --check    學習路線上的課（PATHS）必讀超過 MUST_MAX 字就失敗（validate:content 之後跑）
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const { ALL_DOMAINS, PATHS } = await import(pathToFileURL(resolve(here, '../src/content/roadmap.js')).href)
export const MUST_MAX = 1500
const CHECK = process.argv.includes('--check')
const strip = (s) => s.replace(/```[\s\S]*?```/g, '').replace(/^:::stop.*$/gm, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[#*`|>\-\[\]()]/g, '').replace(/\s+/g, '')
const onPath = new Set(Object.values(PATHS).flat().map((p) => p.skill))
const rows = []
for (const d of ALL_DOMAINS) for (const s of d.skills) {
  const md = readFileSync(resolve(here, '../src/content/deep', s.id + '.md'), 'utf8')
  const i = md.search(/^:::stop/m)
  rows.push({ id: s.id, track: d.track, path: onPath.has(s.id), must: strip(i < 0 ? md : md.slice(0, i)).length, all: strip(md).length })
}
const med = (a) => { a = [...a].sort((x, y) => x - y); return a[a.length >> 1] || 0 }
const over = rows.filter((r) => r.path && r.must > MUST_MAX)
if (!CHECK) {
  for (const t of ['frontend', 'backend', 'ai']) {
    const r = rows.filter((x) => x.track === t), p = r.filter((x) => x.path)
    console.log(`${t}：必讀中位數 ${med(r.map((x) => x.must))} 字（主線 ${p.length} 課：${med(p.map((x) => x.must))} 字），全文中位數 ${med(r.map((x) => x.all))} 字`)
  }
  console.log(`主線課必讀超過 ${MUST_MAX} 字：${over.length} / ${rows.filter((r) => r.path).length}`)
  for (const r of over.sort((a, b) => b.must - a.must)) console.log(`  ${r.track} ${r.id} 必讀 ${r.must}，全文 ${r.all}`)
} else if (over.length) {
  console.error(`深入內容：${over.length} 堂主線課的必讀部分（第一個停靠點之前）超過 ${MUST_MAX} 字：`)
  for (const r of over) console.error(`  ${r.id} ${r.must} 字`)
  process.exit(1)
} else console.log(`深入內容：主線 ${rows.filter((r) => r.path).length} 課的必讀都在 ${MUST_MAX} 字以內`)
