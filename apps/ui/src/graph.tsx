import { useEffect, useRef, useState } from 'react';
import { useApp } from './ctx.tsx';
import type { GraphNode, GraphResult } from './types.ts';

/**
 * Interactive knowledge graph on a canvas: force layout (repulsion + link springs + gravity), zoom to cursor, pan,
 * drag nodes, hover highlights neighbours, click opens. No dependencies; fine for a few thousand nodes.
 */

interface SimNode {
  n: GraphNode;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  fixed: boolean;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

function cssVar(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

export function GraphCanvas({
  data,
  focusId,
  compact,
  highlight,
  onOpen,
}: {
  data: GraphResult;
  focusId?: string;
  compact?: boolean;
  /** Lower-cased substring: matching nodes are emphasized, the rest faded. */
  highlight?: string;
  onOpen: (n: GraphNode) => void;
}) {
  const { theme } = useApp();
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hoverLabel, setHoverLabel] = useState<{ x: number; y: number; text: string; path: string } | null>(null);
  const state = useRef<{
    nodes: SimNode[];
    byId: Map<string, SimNode>;
    links: { a: SimNode; b: SimNode }[];
    neigh: Map<string, Set<string>>;
    view: { x: number; y: number; k: number };
    alpha: number;
    hover: SimNode | null;
    drag: { node: SimNode | null; sx: number; sy: number; vx: number; vy: number; moved: boolean } | null;
    w: number;
    h: number;
    raf: number;
    /** The user zoomed or panned: stop fitting the view automatically. */
    userView: boolean;
    needsDraw: boolean;
  } | null>(null);
  const highlightRef = useRef(highlight);
  highlightRef.current = highlight;
  useEffect(() => {
    if (state.current) state.current.needsDraw = true;
  }, [highlight]);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  // (re)build the simulation when the data changes; keep positions of nodes that stay
  useEffect(() => {
    const prev = state.current;
    const byId = new Map<string, SimNode>();
    const nodes = data.nodes.map((n) => {
      const old = prev?.byId.get(n.id);
      const deg = n.degree ?? 0;
      const s: SimNode = old ? { ...old, n } : { n, x: (hash(n.id) - 0.5) * 400, y: (hash(n.id + '#') - 0.5) * 400, vx: 0, vy: 0, r: 0, fixed: false };
      s.r = n.id === focusId ? 9 : n.type === 'unresolved' ? 4 : Math.min(16, 4.5 + Math.sqrt(deg) * 2.2);
      byId.set(n.id, s);
      return s;
    });
    const links = data.edges.map((e) => ({ a: byId.get(e.src)!, b: byId.get(e.dst)! })).filter((l) => l.a && l.b && l.a !== l.b);
    const neigh = new Map<string, Set<string>>();
    for (const l of links) {
      if (!neigh.has(l.a.n.id)) neigh.set(l.a.n.id, new Set());
      if (!neigh.has(l.b.n.id)) neigh.set(l.b.n.id, new Set());
      neigh.get(l.a.n.id)!.add(l.b.n.id);
      neigh.get(l.b.n.id)!.add(l.a.n.id);
    }
    const focus = focusId ? byId.get(focusId) : undefined;
    if (focus && !prev) {
      focus.x = 0;
      focus.y = 0;
    }
    state.current = { nodes, byId, links, neigh, view: prev?.view ?? { x: 0, y: 0, k: 1 }, alpha: 1, hover: null, drag: null, w: prev?.w ?? 300, h: prev?.h ?? 200, raf: prev?.raf ?? 0, userView: !!prev?.userView && nodes.length === prev.nodes.length, needsDraw: true };
  }, [data, focusId]);

  useEffect(() => {
    const c = canvas.current!;
    const ctx = c.getContext('2d')!;
    let stopped = false;

    const resize = () => {
      const s = state.current!;
      const r = wrap.current!.getBoundingClientRect();
      s.w = Math.max(100, r.width);
      s.h = Math.max(100, r.height);
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.round(s.w * dpr);
      c.height = Math.round(s.h * dpr);
      c.style.width = `${s.w}px`;
      c.style.height = `${s.h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const ro = new ResizeObserver(() => {
      resize();
      if (!state.current!.userView) fit();
      state.current!.needsDraw = true;
    });
    ro.observe(wrap.current!);
    resize();

    const tick = () => {
      const s = state.current!;
      const { nodes, links } = s;
      const n = nodes.length;
      const rep = compact ? 900 : 1400;
      for (let i = 0; i < n; i++) {
        const a = nodes[i]!;
        for (let j = i + 1; j < n; j++) {
          const b = nodes[j]!;
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) {
            dx = (hash(a.n.id + b.n.id) - 0.5) * 2;
            dy = 1;
            d2 = 1;
          }
          if (d2 > 250000) continue;
          const f = (rep * s.alpha) / d2;
          const d = Math.sqrt(d2);
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          a.vx -= fx;
          a.vy -= fy;
          b.vx += fx;
          b.vy += fy;
        }
      }
      const L = compact ? 60 : 80;
      for (const { a, b } of links) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = ((d - L) / d) * 0.06 * s.alpha;
        a.vx += dx * f;
        a.vy += dy * f;
        b.vx -= dx * f;
        b.vy -= dy * f;
      }
      for (const p of nodes) {
        p.vx -= p.x * 0.012 * s.alpha;
        p.vy -= p.y * 0.012 * s.alpha;
        if (p.fixed) {
          p.vx = 0;
          p.vy = 0;
          continue;
        }
        p.vx *= 0.82;
        p.vy *= 0.82;
        p.x += Math.max(-30, Math.min(30, p.vx));
        p.y += Math.max(-30, Math.min(30, p.vy));
      }
      s.alpha = Math.max(0, s.alpha * 0.985 - 0.0005);
    };

    const fit = () => {
      const s = state.current!;
      if (!s.nodes.length) return;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of s.nodes) {
        minX = Math.min(minX, p.x - p.r);
        minY = Math.min(minY, p.y - p.r);
        maxX = Math.max(maxX, p.x + p.r);
        maxY = Math.max(maxY, p.y + p.r);
      }
      const pad = compact ? 24 : 60;
      const k = Math.min(2.2, Math.max(0.15, Math.min((s.w - pad * 2) / (maxX - minX || 1), (s.h - pad * 2) / (maxY - minY || 1))));
      s.view = { k, x: s.w / 2 - ((minX + maxX) / 2) * k, y: s.h / 2 - ((minY + maxY) / 2) * k };
    };

    function draw() {
      const s = state.current!;
      const el = c;
      const accent = cssVar(el, '--aos-color-accent', '#7c5cff');
      const text = cssVar(el, '--aos-color-text', '#222');
      const muted = cssVar(el, '--aos-color-muted', '#888');
      const line = cssVar(el, '--aos-color-line', '#ccc');
      const bg = cssVar(el, '--aos-color-surface', '#fff');
      ctx.clearRect(0, 0, s.w, s.h);
      ctx.save();
      ctx.translate(s.view.x, s.view.y);
      ctx.scale(s.view.k, s.view.k);
      const hov = s.hover;
      const hn = hov ? s.neigh.get(hov.n.id) : null;
      const hl = highlightRef.current;
      const isHl = (p: SimNode) => !!hl && (p.n.label.toLowerCase().includes(hl) || String(p.n.props.path ?? '').toLowerCase().includes(hl));
      const faded = (p: SimNode) => (hov ? p !== hov && !hn?.has(p.n.id) : hl ? !isHl(p) : false);
      ctx.lineWidth = 1 / s.view.k;
      for (const { a, b } of s.links) {
        const on = hov && (a === hov || b === hov);
        ctx.strokeStyle = on ? accent : line;
        ctx.globalAlpha = on ? 0.9 : hov || hl ? 0.18 : 0.7;
        ctx.lineWidth = (on ? 1.8 : 1) / s.view.k;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      for (const p of s.nodes) {
        const f = faded(p);
        ctx.globalAlpha = f ? 0.25 : 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        if (p.n.type === 'unresolved') {
          ctx.fillStyle = bg;
          ctx.fill();
          ctx.setLineDash([2 / s.view.k, 2 / s.view.k]);
          ctx.strokeStyle = muted;
          ctx.lineWidth = 1.4 / s.view.k;
          ctx.stroke();
          ctx.setLineDash([]);
        } else {
          ctx.fillStyle = p.n.type === 'note' ? accent : muted;
          ctx.fill();
        }
        if (p.n.id === focusId || p === hov || (hl && isHl(p))) {
          ctx.strokeStyle = text;
          ctx.lineWidth = 2 / s.view.k;
          ctx.stroke();
        }
      }
      // labels: always in compact mode; otherwise for big nodes, when zoomed in, or around the hovered node
      ctx.font = `${12 / s.view.k}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const p of s.nodes) {
        const show = compact || s.view.k > 1.15 || p.r >= 8 || p === hov || hn?.has(p.n.id) || p.n.id === focusId || (hl && isHl(p));
        if (!show) continue;
        ctx.globalAlpha = faded(p) ? 0.25 : 0.95;
        const label = p.n.label.length > 32 ? `${p.n.label.slice(0, 31)}…` : p.n.label;
        ctx.lineWidth = 3 / s.view.k;
        ctx.strokeStyle = bg;
        ctx.strokeText(label, p.x, p.y + p.r + 3 / s.view.k);
        ctx.fillStyle = p.n.type === 'unresolved' ? muted : text;
        ctx.fillText(label, p.x, p.y + p.r + 3 / s.view.k);
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    let warm = 0;
    const loop = () => {
      if (stopped) return;
      const s = state.current!;
      if (s.alpha > 0.002) {
        // pre-settle a little before the first frame so the graph does not explode on screen
        const steps = warm < 1 ? 120 : 1;
        for (let i = 0; i < steps; i++) tick();
        warm++;
        // keep the whole graph in view while it settles, until the user takes over the view
        if (!s.userView) fit();
        s.needsDraw = true;
      }
      if (s.needsDraw) {
        s.needsDraw = false;
        draw();
      }
      s.raf = requestAnimationFrame(loop);
    };
    loop();

    const toWorld = (ev: { clientX: number; clientY: number }) => {
      const s = state.current!;
      const r = c.getBoundingClientRect();
      return { x: (ev.clientX - r.left - s.view.x) / s.view.k, y: (ev.clientY - r.top - s.view.y) / s.view.k, sx: ev.clientX - r.left, sy: ev.clientY - r.top };
    };
    const pick = (wx: number, wy: number) => {
      const s = state.current!;
      for (let i = s.nodes.length - 1; i >= 0; i--) {
        const p = s.nodes[i]!;
        const r = p.r + 4 / s.view.k;
        if ((p.x - wx) ** 2 + (p.y - wy) ** 2 <= r * r) return p;
      }
      return null;
    };
    const onDown = (ev: PointerEvent) => {
      const s = state.current!;
      const w = toWorld(ev);
      const node = pick(w.x, w.y);
      s.drag = { node, sx: w.sx, sy: w.sy, vx: s.view.x, vy: s.view.y, moved: false };
      if (node) node.fixed = true;
      c.setPointerCapture(ev.pointerId);
    };
    const onMove = (ev: PointerEvent) => {
      const s = state.current!;
      const w = toWorld(ev);
      s.needsDraw = true;
      if (s.drag) {
        if (Math.abs(w.sx - s.drag.sx) + Math.abs(w.sy - s.drag.sy) > 3) s.drag.moved = true;
        if (s.drag.node) {
          s.drag.node.x = w.x;
          s.drag.node.y = w.y;
          s.alpha = Math.max(s.alpha, 0.3);
        } else {
          s.userView = true;
          s.view.x = s.drag.vx + (w.sx - s.drag.sx);
          s.view.y = s.drag.vy + (w.sy - s.drag.sy);
        }
        return;
      }
      const node = pick(w.x, w.y);
      if (node !== s.hover) {
        s.hover = node;
        c.style.cursor = node ? 'pointer' : 'grab';
        setHoverLabel(node ? { x: w.sx, y: w.sy, text: node.n.label, path: node.n.type === 'unresolved' ? 'the note does not exist yet' : String(node.n.props.path ?? '') } : null);
      } else if (node) setHoverLabel((h) => (h ? { ...h, x: w.sx, y: w.sy } : h));
    };
    const onUp = (ev: PointerEvent) => {
      const s = state.current!;
      const d = s.drag;
      s.drag = null;
      if (d?.node) d.node.fixed = false;
      if (d && !d.moved && d.node) openRef.current(d.node.n);
      c.releasePointerCapture(ev.pointerId);
    };
    const onLeave = () => {
      const s = state.current!;
      s.hover = null;
      s.needsDraw = true;
      setHoverLabel(null);
    };
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const s = state.current!;
      const w = toWorld(ev);
      const k = Math.min(6, Math.max(0.08, s.view.k * Math.exp(-ev.deltaY * 0.0015)));
      s.userView = true;
      s.view = { k, x: w.sx - w.x * k, y: w.sy - w.y * k };
      s.needsDraw = true;
    };
    c.addEventListener('pointerdown', onDown);
    c.addEventListener('pointermove', onMove);
    c.addEventListener('pointerup', onUp);
    c.addEventListener('pointerleave', onLeave);
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      stopped = true;
      cancelAnimationFrame(state.current?.raf ?? 0);
      ro.disconnect();
      c.removeEventListener('pointerdown', onDown);
      c.removeEventListener('pointermove', onMove);
      c.removeEventListener('pointerup', onUp);
      c.removeEventListener('pointerleave', onLeave);
      c.removeEventListener('wheel', onWheel);
    };
  }, [compact, focusId, theme]);

  return (
    <div ref={wrap} className={`graph-canvas ${compact ? 'compact' : ''}`}>
      <canvas ref={canvas} aria-label="Graph of links between notes" role="img" />
      {hoverLabel && (
        <div className="graph-tip" style={{ left: hoverLabel.x + 14, top: hoverLabel.y + 10 }}>
          <div>{hoverLabel.text}</div>
          {hoverLabel.path && <div className="muted small mono">{hoverLabel.path}</div>}
        </div>
      )}
    </div>
  );
}
