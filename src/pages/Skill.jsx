import React, { useEffect } from 'react'
import { findSkill, neighbors, displayNo, relatedOf, PATHS } from '../content/roadmap.js'
import { findTrack } from '../content/tracks.js'
import { withTrack } from '../components/TrackFilter.jsx'
import { readSkillBody } from '../content/skillBody.js'
import { readSkillDeep, preloadSkillDeep, hasDeep } from '../content/skillDeep.js'
import Markdown, { countStops, parse as parseMd, inline as inlineMd, slug } from '../components/Markdown.jsx'
import { useLocalChecks } from '../localStore.js'
import Challenge from '../components/Challenge.jsx'
import { WEEK_OF } from '../content/curriculum-weeks.js'
import { playgroundHref, runLangOf } from '../playgroundLink.js'
import { useProgress } from '../progress.js'
import { Level, DomainPill, LabEmbed, labTitle } from '../components/bits.jsx'
import { Callout } from '../labs/ui.jsx'
import ExerciseRunner from '../components/ExerciseRunner.jsx'
import Quiz from '../components/Quiz.jsx'
import { assessmentFor } from '../assess.js'
import { scenariosForSkill } from '../content/scenarios/index.js'

export default function Skill({ id }) {
  const s = findSkill(id)
  const progress = useProgress()
  const { isDone, toggleDone, checks, toggleCheck } = progress
  useEffect(() => { window.scrollTo({ top: 0 }) }, [id])
  if (!s) return <p className="status-msg">找不到這一課：{id}</p>

  const d = s.domain
  if (hasDeep(s.id)) preloadSkillDeep(s.id)   // 跟內文一起開始下載，不用等內文到了才發出請求
  const body = readSkillBody(d, s.id)   // 內文另外一個 chunk：沒到就 suspend（換頁時舊頁面留著）
  const color = `var(--c-${d.color})`
  const done = isDone(s.id)
  const { prev, next } = neighbors(s.id)
  const checkState = checks(s.id, body.checklist.length)
  const checkedN = checkState.filter(Boolean).length
  const assess = assessmentFor(s.id, progress)
  const related = scenariosForSkill(s.id)
  const t = findTrack(d.track)
  const crossTrack = relatedOf(s.id)
  const path = PATHS[d.track] || []
  const station = path.findIndex((p) => p.skill === s.id)
  const week = WEEK_OF[s.id]
  const canExplain = body.checklist.length > 0 && checkedN === body.checklist.length
  const quizPassed = assess.quiz && progress.quizStatus(s.id) === 'pass'

  return (
    <article className="lesson fade-swap" style={{ '--tint': color }}>
      <div className="reading">
        <p className="crumbs">
          <a href="#/">首頁</a> / <a href={`#/track/${t.id}`}>{t.title}</a> / <a href={`#/domain/${d.id}`}>{d.title}</a>
        </p>
        <header className="lesson-head">
          <p className="kicker tinted">{t.title} {displayNo(d)} · {d.en}</p>
          <h1>{s.title}</h1>
          <p className="en">{s.en}</p>
          <div className="lesson-meta">
            <Level level={s.level} />
            <DomainPill domain={d} />
            {station >= 0 && <a href={`#/track/${t.id}`} className="pill" title={`${t.title}學習路線`}>學習路線第 {station + 1}／{path.length} 站</a>}
            {week && <a href={withTrack('curriculum', d.track, { week })} className="pill" title="到課綱的這一週">課綱第 {week} 週</a>}
            {s.lab && <a href="#lab" className="pill tint" style={{ '--tint': color }}>互動實驗室</a>}
            {assess.total > 0 && <a href="#assess" className={`pill${assess.complete ? ' assess-ok' : ''}`}>{assess.complete ? '✓ 驗收通過' : `驗收 ${assess.passed}/${assess.total}`}</a>}
            {s.keywords.map((k) => <a key={k} href={withTrack('roadmap', d.track, { kw: k })} className="pill mono">{k}</a>)}
            {s.reviewed && <span className="pill" title="這一課提到的版本、規格或事件會隨時間變動，這是最後一次核對內容的時間">內容核對：{s.reviewed.replace('-', ' 年 ').replace(/^(\d+ 年 )0?(\d+)$/, '$1$2 月')}</span>}
          </div>
          <p className="lede">{s.summary}</p>
        </header>

        <div className="example-box">
          <span>範例技術 <b>{s.example.primary}</b></span>
          {s.example.alts?.length > 0 && <span className="alts">也常見：{s.example.alts.join('、')}</span>}
        </div>
      </div>

      <div className="course-bar">
        <nav className="course-toc" aria-label="本課章節">
          {body.map && <a href="#map">地圖</a>}
          {s.lab && <a href="#lab" className="lab-link">▶ 實驗室</a>}
          <a href="#points">重點（{body.points.length}）</a>
          {hasDeep(s.id) && <a href="#deep">深入</a>}
          {hasDeep(s.id) && <React.Suspense fallback={null}><StopLink id={s.id} /></React.Suspense>}
          {assess.total > 0 && <a href="#assess">驗收（{assess.passed}/{assess.total}）</a>}
          {body.challenge && <a href="#challenge">進階驗收</a>}
          <a href="#check">自我檢核（{checkedN}/{body.checklist.length}）</a>
          {body.refs.length > 0 && <a href="#refs">延伸閱讀</a>}
        </nav>
        <div className="lesson-states" role="group" aria-label="這一課的進度">
          <button className={`btn small done-btn${done ? ' is-done' : ' ghost'}`} aria-pressed={done} onClick={() => toggleDone(s.id)}>
            {done ? '✓ 讀過' : '標記讀過'}
          </button>
          <a href="#check" className={`lesson-state${canExplain ? ' on' : ''}`} title={`自我檢核 ${checkedN} / ${body.checklist.length}`}>{canExplain ? '✓ ' : ''}能自行解釋</a>
          {assess.quiz && <a href="#assess" className={`lesson-state${quizPassed ? ' on' : ''}`} title="選擇題全對">{quizPassed ? '✓ ' : ''}測驗通過</a>}
        </div>
      </div>

      {body.map && <MapLayer map={body.map} />}

      {s.lab && (
        <section className="lab-full">
          <h2 id="lab" className="lab-full-title">動手玩：{labTitle(s.lab)}</h2>
          <LabEmbed name={s.lab} />
        </section>
      )}

      <div className="reading">
        <div className="lesson-body">
          <h2 id="points">重點</h2>
          <ul className="points">
            {body.points.map((p, i) => <li key={i}><span><b><Inline text={p.b} /></b>　<Inline text={p.t} /></span></li>)}
          </ul>

          {hasDeep(s.id) && (
            <React.Suspense fallback={<p className="muted">載入深入內容…</p>}>
              <Deep id={s.id} />
            </React.Suspense>
          )}

          <h2 id="assess">驗收 <span className="muted" style={{ fontSize: '0.85rem', fontFamily: 'var(--sans)', fontWeight: 500 }}>{assess.total > 0 ? `${assess.passed} / ${assess.total}` : ''}</span></h2>
          {assess.total === 0 && <p className="muted">這一課的驗收題目撰寫中。</p>}
          {assess.exercises.map((ex) => <ExerciseRunner key={ex.id} exercise={ex} compact />)}
          {assess.quiz && <Quiz key={s.id} skillId={s.id} questions={assess.quiz} />}
          {body.challenge && <Challenge challenge={body.challenge} storeKey={`challenge:${s.id}`} />}
          {assess.quiz && <p className="rv-after">做完了？<a href={withTrack('review', d.track)}>到複習頁混合練習 →</a></p>}

          <h2 id="check">自我檢核 <span className="muted" style={{ fontSize: '0.85rem', fontFamily: 'var(--sans)', fontWeight: 500 }}>{checkedN} / {body.checklist.length}</span></h2>
          <ul className="checklist">
            {body.checklist.map((c, i) => (
              <li key={i}>
                <label>
                  <input type="checkbox" checked={checkState[i]} onChange={() => toggleCheck(s.id, i, body.checklist.length)} />
                  <span>{c}</span>
                </label>
              </li>
            ))}
          </ul>
          {canExplain && <Callout tone="good" title="✓ 能自行解釋" />}

          {related.length > 0 && (
            <>
              <h2 id="scenarios">相關設計情境</h2>
              <ul className="refs">
                {related.map((sc) => <li key={sc.id}><a href={`#/scenario/${sc.id}`}>{sc.title} →</a></li>)}
              </ul>
            </>
          )}

          {crossTrack.length > 0 && (
            <>
              <h2 id="related">其他路線的相關課</h2>
              <ul className="refs">
                {crossTrack.map((x) => <li key={x.id}><a href={`#/skill/${x.id}`}>{findTrack(x.domain.track).title}｜{x.title} →</a></li>)}
              </ul>
            </>
          )}

          {body.refs.length > 0 && (
            <>
              <h2 id="refs">延伸閱讀</h2>
              <ul className="refs">
                {body.refs.map((r) => <li key={r.url}><a href={r.url} target="_blank" rel="noreferrer">{r.label} ↗</a></li>)}
              </ul>
            </>
          )}
        </div>

        <nav className="lesson-nav">
          {prev ? <a href={`#/skill/${prev.id}`}><small>上一課</small>← {prev.title}</a> : <span />}
          {next ? <a className="next" href={`#/skill/${next.id}`}><small>下一課</small>{next.title} →</a> : <span />}
        </nav>
      </div>
    </article>
  )
}

/* 深入內容：依 md 的 ## 切成章節，一章一個可收合的區塊，預設只打開第一章。
   第一個停靠點之前的章是必讀，之後是選讀；每章標出大約幾分鐘，讀完按「讀完，下一章」會收起這章、打開下一章（紀錄只存在這個瀏覽器）。
   標記 run 的 python / sql / js 範例可以在 Playground 開。 */
const minutesOf = (blocks) => {
  let chars = 0, code = 0
  for (const b of blocks) {
    if (b.type === 'code') code++
    else if (b.type === 'list') chars += b.items.reduce((n, it) => n + it.text.length, 0)
    else if (b.type === 'table') chars += [b.header, ...b.body].flat().join('').length
    else if (b.type === 'quote') chars += b.lines.join('').length
    else chars += (b.text || '').length
  }
  return Math.max(1, Math.round(chars / 450 + code * 0.5))
}
function splitChapters(blocks) {
  const intro = [], chapters = []
  let cur = null, afterStop = false
  for (const b of blocks) {
    if (b.type === 'h' && b.level === 2) { cur = { title: b.text, id: `deep-${slug(b.text)}`, blocks: [], optional: afterStop, stop: null }; chapters.push(cur); continue }
    if (b.type === 'stop') afterStop = true
    ;(cur ? cur.blocks : intro).push(b)
  }
  // 章尾的停靠點拿出來放在兩章之間，章收起來時也看得到
  for (const c of chapters) if (c.blocks.at(-1)?.type === 'stop') c.stop = c.blocks.pop()
  for (const c of chapters) c.minutes = minutesOf(c.blocks)
  return { intro, chapters }
}
function Deep({ id }) {
  const text = readSkillDeep(id)
  const blocks = React.useMemo(() => (text ? parseMd(text) : []), [text])
  const { intro, chapters } = React.useMemo(() => splitChapters(blocks), [blocks])
  const allStops = React.useMemo(() => blocks.filter((b) => b.type === 'stop'), [blocks])
  const [read, toggleRead] = useLocalChecks(`deep:${id}`, chapters.length)
  const [open, setOpen] = React.useState(() => new Set([0]))
  React.useEffect(() => { setOpen(new Set([0])) }, [id])
  // 頁內錨點或停靠點連到收起來的章：先打開那一章
  React.useEffect(() => {
    const on = (e) => {
      const k = chapters.findIndex((c) => c.id === e.detail || c.blocks.some((b) => b.type === 'h' && `deep-${slug(b.text)}` === e.detail))
      if (k >= 0) setOpen((o) => new Set(o).add(k))
    }
    window.addEventListener('atlas:reveal', on)
    return () => window.removeEventListener('atlas:reveal', on)
  }, [chapters])
  if (!text) return null
  const action = (b) => (runLangOf(b)
    ? <a className="btn ghost small" href={playgroundHref(runLangOf(b), b.text)}>在 Playground 開啟 ↗</a>
    : null)
  const md = (bs) => <Markdown blocks={bs} allStops={allStops} className="deep-body" headingOffset={1} idFor={(_, sl) => `deep-${sl}`} codeAction={action} stopId={(n) => `deep-stop-${n}`} />
  const must = chapters.filter((c) => !c.optional), opt = chapters.filter((c) => c.optional)
  const sum = (cs) => cs.reduce((n, c) => n + c.minutes, 0)
  const allOpen = open.size === chapters.length
  const setOne = (k, on) => setOpen((o) => { const n = new Set(o); on ? n.add(k) : n.delete(k); return n })
  const finish = (k) => {
    if (!read[k]) toggleRead(k)
    setOpen((o) => { const n = new Set(o); n.delete(k); if (k + 1 < chapters.length) n.add(k + 1); return n })
    requestAnimationFrame(() => document.getElementById(chapters[Math.min(k + 1, chapters.length - 1)].id)?.scrollIntoView({ block: 'start' }))
  }
  return (
    <section className="deep">
      <div className="deep-head">
        <h2 id="deep">深入</h2>
        {chapters.length > 0 && (
          <p className="deep-meta">
            <span>必讀 {must.length} 章 · 約 {sum(must)} 分鐘</span>
            {opt.length > 0 && <span>選讀 {opt.length} 章 · 約 {sum(opt)} 分鐘</span>}
            <span>讀完 {read.filter(Boolean).length} / {chapters.length}</span>
            <button type="button" className="btn ghost small" onClick={() => setOpen(allOpen ? new Set() : new Set(chapters.map((_, k) => k)))}>{allOpen ? '全部收合' : '全部展開'}</button>
          </p>
        )}
      </div>
      {intro.length > 0 && md(intro)}
      {chapters.map((c, k) => (
        <React.Fragment key={c.id}>
          <details className={`deep-ch${read[k] ? ' read' : ''}`} id={c.id} open={open.has(k)} onToggle={(e) => setOne(k, e.currentTarget.open)}>
            <summary>
              <span className="deep-ch-no">{String(k + 1).padStart(2, '0')}</span>
              <h3>{inlineMd(c.title)}</h3>
              <span className={`deep-ch-tag${c.optional ? ' opt' : ''}`}>{c.optional ? '選讀' : '必讀'}</span>
              <span className="deep-ch-min">約 {c.minutes} 分鐘</span>
              {read[k] && <span className="deep-ch-done">✓ 讀完</span>}
            </summary>
            {md(c.blocks)}
            <p className="deep-ch-next">
              <button type="button" className="btn small" onClick={() => finish(k)}>{k + 1 < chapters.length ? '讀完，下一章 →' : '讀完'}</button>
            </p>
          </details>
          {c.stop && md([c.stop])}
        </React.Fragment>
      ))}
    </section>
  )
}

/* 課的目錄列：跳到第一個停靠點（深入內容到了才知道有沒有） */
function StopLink({ id }) {
  const n = countStops(readSkillDeep(id))
  return n > 0 ? <a href="#deep-stop-1">停靠點{n > 1 ? `（${n}）` : ''}</a> : null
}

/* 重點文字裡的 `code` 轉成 <code> */
/* 地圖層：每課的基底。叫得出名字（名詞）、說得出要求（描述需求要講清楚的事與一段範例）、驗得出對錯（怎麼檢查）。
   格式見 docs/CONTRIBUTING-lessons.md 的「地圖層」。 */
function MapLayer({ map }) {
  const [copied, setCopied] = React.useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(map.prompt.replace(/`/g, '')); setCopied(true); setTimeout(() => setCopied(false), 1600) } catch { /* 不能寫剪貼簿時不做事 */ }
  }
  return (
    <div className="reading">
      <section className="lesson-body map-layer" aria-labelledby="map">
        <h2 id="map">地圖</h2>
        <div className="map-block">
          <h3>叫得出名字</h3>
          <dl className="map-names">
            {map.names.map((x) => <div key={x.n}><dt><Inline text={x.n} /></dt><dd><Inline text={x.t} /></dd></div>)}
          </dl>
        </div>
        <div className="map-block">
          <h3>說得出要求</h3>
          <ul>{map.ask.map((a, i) => <li key={i}><Inline text={a} /></li>)}</ul>
          {map.prompt && (
            <figure className="map-prompt">
              <figcaption><span>描述範例</span><button type="button" className="btn ghost small" onClick={copy}>{copied ? '已複製' : '複製'}</button></figcaption>
              <p><Inline text={map.prompt} /></p>
            </figure>
          )}
        </div>
        <div className="map-block">
          <h3>驗得出對錯</h3>
          <ul className="map-verify">{map.verify.map((v, i) => <li key={i}><b><Inline text={v.c} /></b>　<Inline text={v.t} /></li>)}</ul>
        </div>
      </section>
    </div>
  )
}

function Inline({ text }) {
  const parts = text.split(/(`[^`]+`)/g)
  return <>{parts.map((p, i) => p.startsWith('`') ? <code key={i}>{p.slice(1, -1)}</code> : <React.Fragment key={i}>{p}</React.Fragment>)}</>
}
