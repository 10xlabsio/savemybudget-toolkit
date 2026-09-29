/** Inline SVG per-day chart: bars for total clicks with a flagged overlay. Server-rendered, no script. */
import { escapeHtml } from './markdown.js';

export interface DayPoint { day: string; total: number; flag: number }

export function perDayChart(points: DayPoint[], opts: { height?: number; label?: string } = {}): string {
  const H = opts.height ?? 140;
  const W = 720;
  const padL = 34, padR = 6, padT = 10, padB = 22;
  if (!points.length) {
    return `<svg class="svgchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="No clicks in this range"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="var(--grey)" font-size="13" font-family="inherit">No clicks recorded in this range</text></svg>`;
  }
  const max = Math.max(1, ...points.map((p) => p.total));
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const slot = innerW / points.length;
  const bw = Math.max(2, Math.min(28, slot * 0.7));
  const y = (v: number) => padT + innerH - (v / max) * innerH;
  const parts: string[] = [];
  parts.push(`<svg class="svgchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(opts.label ?? 'Clicks per day')}">`);
  // gridlines
  const ticks = niceTicks(max);
  for (const t of ticks) {
    const yy = y(t);
    parts.push(`<line x1="${padL}" x2="${W - padR}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="var(--line)" stroke-width="1"/>`);
    parts.push(`<text x="${padL - 6}" y="${(yy + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--grey)" font-family="inherit">${t}</text>`);
  }
  const labelEvery = Math.max(1, Math.ceil(points.length / 10));
  points.forEach((p, i) => {
    const x = padL + i * slot + (slot - bw) / 2;
    const title = `${p.day}: ${p.total} clicks, ${p.flag} flagged`;
    parts.push(`<g><title>${escapeHtml(title)}</title>`);
    parts.push(`<rect x="${x.toFixed(1)}" y="${y(p.total).toFixed(1)}" width="${bw.toFixed(1)}" height="${(padT + innerH - y(p.total)).toFixed(1)}" rx="2" fill="var(--chart)" opacity="0.55"/>`);
    if (p.flag > 0) {
      parts.push(`<rect x="${x.toFixed(1)}" y="${y(p.flag).toFixed(1)}" width="${bw.toFixed(1)}" height="${(padT + innerH - y(p.flag)).toFixed(1)}" rx="2" fill="var(--chart-flag)"/>`);
    }
    parts.push('</g>');
    if (i % labelEvery === 0 || i === points.length - 1) {
      parts.push(`<text x="${(x + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="var(--grey)" font-family="inherit">${escapeHtml(p.day.slice(5))}</text>`);
    }
  });
  parts.push('</svg>');
  return parts.join('');
}

function niceTicks(max: number): number[] {
  if (max <= 4) return Array.from({ length: max + 1 }, (_, i) => i).filter((v) => v > 0);
  const raw = max / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? pow * 10;
  const out: number[] = [];
  for (let v = step; v <= max; v += step) out.push(v);
  return out;
}
