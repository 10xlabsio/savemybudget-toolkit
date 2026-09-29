// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
/** Tiny Markdown → HTML converter for docs/*.md and TELEMETRY.md. Escapes first; supports what the docs use. */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Rewrites a link target: relative .md links → /docs/<name>, ../templates/x → /templates/x. */
function rewriteHref(href: string): string {
  if (/^(https?:|mailto:|\/|#)/i.test(href)) return href;
  const m = href.match(/^(?:\.\/)?([A-Za-z0-9_-]+)\.md(#.*)?$/);
  if (m) return `/docs/${m[1]}${m[2] ?? ''}`;
  const t = href.match(/^(?:\.\.\/)+templates\/([A-Za-z0-9._-]+)$/);
  if (t) return `/templates/${t[1]}`;
  const tel = href.match(/^(?:\.\.\/)*TELEMETRY\.md(#.*)?$/);
  if (tel) return `/docs/telemetry${tel[1] ?? ''}`;
  const sec = href.match(/^(?:\.\.\/)*SECURITY\.md(#.*)?$/);
  if (sec) return `/docs/security${sec[1] ?? ''}`;
  return href;
}

function inline(escaped: string): string {
  let s = escaped;
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_m, c) => { codes.push(`<code>${c}</code>`); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, u) => {
    const href = rewriteHref(u);
    const ext = /^https?:/i.test(href);
    return `<a href="${href}"${ext ? ' rel="noopener" target="_blank"' : ''}>${t}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i) => codes[Number(i)]);
  return s;
}

export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
  };
  while (i < lines.length) {
    const raw = lines[i];
    const line = escapeHtml(raw);
    // fenced code
    const fence = raw.match(/^```/);
    if (fence) {
      flush();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(escapeHtml(lines[i])); i++; }
      i++;
      out.push(`<pre><code>${buf.join('\n')}</code></pre>`);
      continue;
    }
    const h = raw.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flush();
      const lvl = h[1].length;
      const text = inline(escapeHtml(h[2].trim()));
      out.push(`<h${lvl} id="${slugify(h[2])}">${text}</h${lvl}>`);
      i++;
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(raw)) { flush(); out.push('<hr />'); i++; continue; }
    if (/^>/.test(raw)) {
      flush();
      const buf: string[] = [];
      while (i < lines.length && /^>/.test(lines[i])) { buf.push(escapeHtml(lines[i].replace(/^>\s?/, ''))); i++; }
      out.push(`<blockquote><p>${inline(buf.join(' '))}</p></blockquote>`);
      continue;
    }
    if (/^\|/.test(raw)) {
      flush();
      const rows: string[][] = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        const cells = lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells.map((c) => inline(escapeHtml(c))));
        i++;
      }
      if (rows.length) {
        const [head, ...body] = rows;
        out.push('<div class="tbl"><table><thead><tr>' + head.map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>'
          + body.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>');
      }
      continue;
    }
    const ul = raw.match(/^\s*[-*]\s+(.*)$/);
    const ol = raw.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flush();
      const tag = ol ? 'ol' : 'ul';
      const re = ol ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*]\s+(.*)$/;
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(re);
        if (m) { items.push(inline(escapeHtml(m[1]))); i++; continue; }
        if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += ' ' + inline(escapeHtml(lines[i].trim())); i++; continue; }
        break;
      }
      out.push(`<${tag}>` + items.map((t) => `<li>${t}</li>`).join('') + `</${tag}>`);
      continue;
    }
    if (raw.trim() === '') { flush(); i++; continue; }
    para.push(line);
    i++;
  }
  flush();
  return out.join('\n');
}

/** First H1 text of a document, for the page title. */
export function markdownTitle(md: string): string | null {
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

/** Extract the lines of a section (from a heading until the next heading of same or higher level). */
export function markdownSection(md: string, heading: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((l) => new RegExp(`^#{1,4}\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i').test(l));
  if (start < 0) return '';
  const lvl = (lines[start].match(/^#+/) ?? ['#'])[0].length;
  const buf: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,4})\s/);
    if (m && m[1].length <= lvl) break;
    buf.push(lines[i]);
  }
  return buf.join('\n').trim();
}
