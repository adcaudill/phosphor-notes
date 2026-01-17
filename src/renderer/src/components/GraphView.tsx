import React, { useEffect, useRef } from 'react';
import type { SimulationLinkDatum, SimulationNodeDatum } from 'd3-force';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force';
import { select } from 'd3-selection';
import type { Selection } from 'd3-selection';
import { zoom, zoomIdentity, type ZoomTransform } from 'd3-zoom';
import '../styles/GraphView.css';

interface GraphNode extends SimulationNodeDatum {
  id: string;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
  degree?: number;
}

interface GraphLink extends SimulationLinkDatum<GraphNode> {
  source: string | GraphNode;
  target: string | GraphNode;
}

interface GraphViewProps {
  graph: Record<string, string[]>;
  onFileSelect: (filename: string) => void;
}

/**
 * Canvas-based force-directed graph view with zoom/pan and click-to-open.
 */
export const GraphView: React.FC<GraphViewProps> = ({ graph, onFileSelect }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number | undefined>(undefined);
  const transformRef = useRef<ZoomTransform>(zoomIdentity);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    // Build a fresh data set for D3 (it mutates nodes/links)
    const nodes: GraphNode[] = Object.keys(graph).map((id) => ({ id }));
    const links: GraphLink[] = [];
    Object.entries(graph).forEach(([source, targets]) => {
      targets.forEach((target) => {
        if (graph[target]) {
          links.push({ source, target });
        }
      });
    });

    // Calculate node degrees (connection count)
    const degreeMap = new Map<string, number>();
    nodes.forEach((node) => {
      degreeMap.set(node.id, 0);
    });
    links.forEach((link) => {
      const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
      const targetId = typeof link.target === 'string' ? link.target : link.target.id;
      degreeMap.set(sourceId, (degreeMap.get(sourceId) || 0) + 1);
      degreeMap.set(targetId, (degreeMap.get(targetId) || 0) + 1);
    });
    let maxDegree = 0;
    nodes.forEach((node) => {
      node.degree = degreeMap.get(node.id) || 0;
      maxDegree = Math.max(maxDegree, node.degree);
    });

    // If there is no data, just clear and bail out
    if (nodes.length === 0) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return undefined;
    }

    let width = 0;
    let height = 0;
    const dpr = window.devicePixelRatio || 1;

    const resize = (): void => {
      const rect = canvas.parentElement?.getBoundingClientRect();
      width = rect?.width || window.innerWidth;
      height = rect?.height || window.innerHeight;

      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();
    window.addEventListener('resize', resize);

    // Resolve theme CSS variables for canvas rendering (colors, fonts)
    const resolvedStyle = getComputedStyle(canvas.parentElement || document.documentElement);
    const getVar = (name: string, fallback = ''): string =>
      (resolvedStyle.getPropertyValue(name) || fallback).trim();

    const parseHex = (hex: string): { r: number; g: number; b: number } | null => {
      const h = hex.replace('#', '').trim();
      if (h.length === 3) {
        return {
          r: parseInt(h[0] + h[0], 16),
          g: parseInt(h[1] + h[1], 16),
          b: parseInt(h[2] + h[2], 16)
        };
      }
      if (h.length === 6) {
        return {
          r: parseInt(h.slice(0, 2), 16),
          g: parseInt(h.slice(2, 4), 16),
          b: parseInt(h.slice(4, 6), 16)
        };
      }
      return null;
    };

    const toRgba = (color: string, alpha = 1): string => {
      const c = color.trim();
      if (!c) return `rgba(148,163,184,${alpha})`;
      if (c.startsWith('rgba')) return c;
      if (c.startsWith('rgb')) {
        return c.replace(/rgb\(/, 'rgba(').replace(/\)$/, `, ${alpha})`);
      }
      const p = parseHex(c);
      if (p) return `rgba(${p.r}, ${p.g}, ${p.b}, ${alpha})`;
      return `rgba(148,163,184,${alpha})`;
    };

    const cssPrimary = getVar('--color-primary', '#60a5fa');
    const cssPrimaryRgb = getVar('--color-primary-rgb', '').replace(/\s+/g, '');
    const cssTextPrimary = getVar('--color-text-primary', '#94a3b8');
    const cssTextSecondary = getVar('--color-text-secondary', '#cbd5e1');
    const bodyStyle = getComputedStyle(document.body);
    const cssFontFamily =
      bodyStyle.fontFamily || '"Inter", "SF Pro Text", -apple-system, system-ui, sans-serif';
    const cssFontSize = getVar('--font-size-sm', '12px');

    let transform = transformRef.current;
    let isDragging = false;
    let draggedNode: GraphNode | null = null;

    const render = (): void => {
      ctx.save();
      ctx.clearRect(0, 0, width, height);
      ctx.translate(transform.x, transform.y);
      ctx.scale(transform.k, transform.k);

      // Edges
      ctx.beginPath();
      ctx.strokeStyle = toRgba(cssTextSecondary, 0.6);
      ctx.lineWidth = 1;
      links.forEach((link) => {
        const source = link.source as GraphNode;
        const target = link.target as GraphNode;
        if (source.x === undefined || source.y === undefined) return;
        if (target.x === undefined || target.y === undefined) return;
        ctx.moveTo(source.x, source.y);
        ctx.lineTo(target.x, target.y);
      });
      ctx.stroke();

      // Nodes
      nodes.forEach((node) => {
        if (node.x === undefined || node.y === undefined) return;
        const baseRadius = 6;
        const maxRadiusIncrease = 10;
        const scaledRadius =
          baseRadius + ((node.degree || 0) / Math.max(maxDegree, 1)) * maxRadiusIncrease;
        ctx.beginPath();
        ctx.fillStyle = cssPrimary;
        ctx.strokeStyle = cssPrimaryRgb ? `rgba(${cssPrimaryRgb}, 0.35)` : toRgba(cssPrimary, 0.35);
        ctx.lineWidth = 2;
        ctx.arc(node.x, node.y, scaledRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Labels only when zoomed in
        if (transform.k > 1.1) {
          ctx.fillStyle = cssTextPrimary;
          ctx.font = `${cssFontSize} ${cssFontFamily}`;
          // strip file extension for label
          const label = node.id.replace(/\.[^/.]+$/, '');
          ctx.fillText(label, node.x + 10, node.y + 4);
        }
      });

      ctx.restore();
    };

    const scheduleRender = (): void => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      frameRef.current = window.requestAnimationFrame(render);
    };

    // Simulation
    const sim = forceSimulation(nodes)
      .force(
        'link',
        forceLink<GraphNode, GraphLink>(links)
          .id((d) => d.id)
          .distance(110)
      )
      .force('charge', forceManyBody().strength(-160))
      .force(
        'collide',
        forceCollide<GraphNode>()
          .radius((d) => {
            const baseRadius = 6;
            const maxRadiusIncrease = 10;
            const calculatedRadius =
              baseRadius + ((d.degree || 0) / Math.max(maxDegree, 1)) * maxRadiusIncrease + 8;
            return calculatedRadius * 3; // multiplied to give more space & avoid overlap
          })
          .strength(0.8)
      )
      .force('center', forceCenter(width / 2, height / 2))
      .alphaDecay(0.03);

    sim.on('tick', scheduleRender);

    // Zoom/pan
    const zoomBehavior = zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.2, 5])
      .on('zoom', (event) => {
        transform = event.transform;
        transformRef.current = transform;
        scheduleRender();
      });

    const selection = select<HTMLCanvasElement, unknown>(canvas);
    selection.call(zoomBehavior);

    // Apply a sensible initial zoom so node labels are visible by default.
    // Labels are rendered when transform.k > 1.1, so choose a value above that.
    const initialScale = 1.2;
    const initialTransform = zoomIdentity
      .translate((width / 2) * (1 - initialScale), (height / 2) * (1 - initialScale))
      .scale(initialScale);
    transform = initialTransform;
    transformRef.current = initialTransform;
    // Programmatically set the zoom behavior's transform on the selection
    const applyTransform = (
      zoomBehavior as unknown as {
        transform: (
          sel: Selection<HTMLCanvasElement, unknown, null, undefined>,
          t: ZoomTransform
        ) => void;
      }
    ).transform;
    applyTransform(selection, initialTransform);
    scheduleRender();

    const toGraphCoords = (clientX: number, clientY: number): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (clientX - rect.left - transform.x) / transform.k,
        y: (clientY - rect.top - transform.y) / transform.k
      };
    };

    const findNodeAt = (x: number, y: number): GraphNode | undefined => {
      const hitRadius = 10;
      const baseRadius = 6;
      const maxRadiusIncrease = 10;
      return nodes.find((node) => {
        if (node.x === undefined || node.y === undefined) return false;
        const scaledRadius =
          baseRadius + ((node.degree || 0) / Math.max(maxDegree, 1)) * maxRadiusIncrease;
        const dx = x - node.x;
        const dy = y - node.y;
        return Math.sqrt(dx * dx + dy * dy) <= scaledRadius + hitRadius;
      });
    };

    const handlePointerDown = (event: PointerEvent): void => {
      const { x, y } = toGraphCoords(event.clientX, event.clientY);
      const node = findNodeAt(x, y);
      if (node) {
        draggedNode = node;
        isDragging = false;
        node.fx = node.x;
        node.fy = node.y;
        sim.alphaTarget(0.3).restart();
      }
    };

    const handlePointerMove = (event: PointerEvent): void => {
      if (!draggedNode) return;
      const { x, y } = toGraphCoords(event.clientX, event.clientY);
      draggedNode.fx = x;
      draggedNode.fy = y;
      isDragging = true;
      scheduleRender();
    };

    const handlePointerUp = (): void => {
      if (draggedNode) {
        draggedNode.fx = undefined;
        draggedNode.fy = undefined;
        sim.alphaTarget(0);
      }
      draggedNode = null;
      isDragging = false;
    };

    const handleClick = async (event: MouseEvent): Promise<void> => {
      if (isDragging) {
        isDragging = false;
        return;
      }
      const { x, y } = toGraphCoords(event.clientX, event.clientY);
      const node = findNodeAt(x, y);
      if (node?.id) {
        onFileSelect(node.id);
      }
    };

    canvas.addEventListener('pointerdown', handlePointerDown);
    canvas.addEventListener('pointermove', handlePointerMove);
    canvas.addEventListener('pointerup', handlePointerUp);
    canvas.addEventListener('pointerleave', handlePointerUp);
    canvas.addEventListener('click', handleClick);

    // Kick off initial paint
    scheduleRender();

    return () => {
      window.removeEventListener('resize', resize);
      selection.on('.zoom', null);
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerup', handlePointerUp);
      canvas.removeEventListener('pointerleave', handlePointerUp);
      canvas.removeEventListener('click', handleClick);
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      sim.stop();
    };
  }, [graph, onFileSelect]);

  const hasGraphData = Object.keys(graph).length > 0;

  return (
    <div className="graph-view">
      {!hasGraphData && (
        <div className="graph-empty">Graph will appear once notes link to each other.</div>
      )}
      <canvas ref={canvasRef} className="graph-canvas" />
    </div>
  );
};
