import { Fragment } from 'react'

// The AI's answer as formatted text: code blocks, headings, tables, lists, bold,
// inline code and links. Built from React elements only — never raw HTML — so
// whatever the model writes cannot run in the page.
const LINK = /(https?:\/\/[^\s)<>]+)/g

function inline(text, key = 'i') {
    // `code` first (nothing inside it is formatted), then **bold**, then links
    const out = []
    String(text).split(/(`[^`\n]+`)/g).forEach((part, i) => {
        if (/^`[^`]+`$/.test(part)) { out.push(<code key={`${key}c${i}`} className="rounded bg-white/10 px-1 py-0.5 font-mono text-[12px] text-violet-200">{part.slice(1, -1)}</code>); return }
        part.split(/(\*\*[^*\n]+\*\*|__[^_\n]+__)/g).forEach((p, j) => {
            if (/^(\*\*|__).+(\*\*|__)$/.test(p)) { out.push(<strong key={`${key}b${i}-${j}`} className="font-semibold text-white">{p.slice(2, -2)}</strong>); return }
            p.split(LINK).forEach((q, k) => {
                if (/^https?:\/\//.test(q)) out.push(<a key={`${key}l${i}-${j}-${k}`} href={q} target="_blank" rel="noopener noreferrer" className="text-blue-300 hover:underline break-all">{q}</a>)
                else if (q) out.push(<Fragment key={`${key}t${i}-${j}-${k}`}>{q}</Fragment>)
            })
        })
    })
    return out
}

/** One line with **bold**, `code` and links (no blocks). */
export function Inline({ text }) { return <>{inline(text)}</> }

const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l)

export default function Markdown({ text }) {
    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n')
    const blocks = []
    for (let i = 0; i < lines.length;) {
        const l = lines[i]
        // ```code```
        if (/^\s*```/.test(l)) {
            const body = []; i++
            while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++])
            i++
            blocks.push(<pre key={i} className="my-2 overflow-x-auto rounded-xl border border-white/[0.07] bg-black/40 p-3 font-mono text-[12px] leading-relaxed text-slate-200 whitespace-pre">{body.join('\n')}</pre>)
            continue
        }
        // | a | b | + |---|---|
        if (/\|/.test(l) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
            const head = cells(l); const rows = []; i += 2
            while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) rows.push(cells(lines[i++]))
            blocks.push(
                <div key={i} className="my-2 overflow-x-auto">
                    <table className="w-full text-[12px] border-collapse">
                        <thead><tr>{head.map((h, k) => <th key={k} className="border-b border-white/10 px-2 py-1 text-left font-semibold text-slate-200">{inline(h, `h${k}`)}</th>)}</tr></thead>
                        <tbody>{rows.map((r, k) => <tr key={k} className="border-b border-white/5">{r.map((c, m) => <td key={m} className="px-2 py-1 align-top text-slate-300">{inline(c, `c${k}-${m}`)}</td>)}</tr>)}</tbody>
                    </table>
                </div>)
            continue
        }
        // # headings
        const h = /^\s*(#{1,4})\s+(.*)$/.exec(l)
        if (h) { blocks.push(<p key={i} className={`mt-2 mb-1 font-semibold text-white ${h[1].length <= 2 ? 'text-[15px]' : 'text-sm'}`}>{inline(h[2], `H${i}`)}</p>); i++; continue }
        // - bullets / 1. numbers
        if (/^\s*([-*•]|\d+[.)])\s+/.test(l)) {
            const ordered = /^\s*\d+[.)]/.test(l); const items = []
            while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ''))
            const List = ordered ? 'ol' : 'ul'
            blocks.push(<List key={i} className={`my-1 ml-5 space-y-0.5 ${ordered ? 'list-decimal' : 'list-disc'}`}>{items.map((t, k) => <li key={k}>{inline(t, `L${i}-${k}`)}</li>)}</List>)
            continue
        }
        if (!l.trim()) { i++; continue }
        // a paragraph: lines until a blank line or another block
        const para = []
        while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,4}\s|[-*•]\s|\d+[.)]\s)/.test(lines[i]) && !(/\|/.test(lines[i]) && i + 1 < lines.length && isTableSep(lines[i + 1]))) para.push(lines[i++])
        blocks.push(<p key={i} className="my-1">{para.map((t, k) => <Fragment key={k}>{k > 0 && <br />}{inline(t, `P${i}-${k}`)}</Fragment>)}</p>)
    }
    return <div className="kz-md">{blocks}</div>
}
