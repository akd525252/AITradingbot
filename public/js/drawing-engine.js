/**
 * GXM Enterprise Drawing & Analysis Engine v2.0
 * Professional chart drawing & technical analysis tools for GainEX trading platform.
 * Built from scratch — zero external dependencies.
 * Integrates directly with lightweight-charts coordinate system.
 */

(function (window) {
  'use strict';

  // ============================================================
  // MATH & GEOMETRY HELPERS
  // ============================================================
  function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }
  function dist(x1, y1, x2, y2) { return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2); }
  function uid() { return '_gxm_' + Math.random().toString(36).slice(2, 9); }

  function pointToSegmentDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return dist(px, py, x1, y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = clamp(t, 0, 1);
    return dist(px, py, x1 + t * dx, y1 + t * dy);
  }

  function pointToRayDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return dist(px, py, x1, y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, t); // extends indefinitely past end point
    return dist(px, py, x1 + t * dx, y1 + t * dy);
  }

  function pointToLineDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return dist(px, py, x1, y1);
    return Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1) / len;
  }

  function pointInPolygon(px, py, vertices) {
    let inside = false;
    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
      const xi = vertices[i].x, yi = vertices[i].y;
      const xj = vertices[j].x, yj = vertices[j].y;
      const intersect = ((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function getTrendAngle(x1, y1, x2, y2) {
    return Math.atan2(y2 - y1, x2 - x1);
  }

  function normalizeTime(ts) {
    if (!ts) return Date.now();
    return ts < 1e12 ? ts * 1000 : ts;
  }

  // ============================================================
  // COORDINATE CONVERTER
  // ============================================================
  const CoordinateConverter = {
    priceToY(price) {
      try {
        const ch = window.chart;
        const series = ch && (ch.candlestickSeries || ch.areaSeries || ch.barSeries);
        if (!series) return null;
        const y = series.priceToCoordinate(price);
        return (y === null || y === undefined) ? null : y;
      } catch (e) { return null; }
    },

    timeToX(timestampMs) {
      try {
        const ch = window.chart;
        if (!ch || !ch.tvChart) return null;
        const timeSec = Math.floor(timestampMs / 1000);
        const x = ch.tvChart.timeScale().timeToCoordinate(timeSec);
        return (x === null || x === undefined) ? null : x;
      } catch (e) { return null; }
    },

    yToPrice(y) {
      try {
        const ch = window.chart;
        const series = ch && (ch.candlestickSeries || ch.areaSeries || ch.barSeries);
        if (!series) return null;
        return series.coordinateToPrice(y);
      } catch (e) { return null; }
    },

    xToTime(x) {
      try {
        const ch = window.chart;
        if (!ch || !ch.tvChart) return null;
        const timeSec = ch.tvChart.timeScale().coordinateToTime(x);
        if (timeSec === null || timeSec === undefined) return null;
        return timeSec * 1000;
      } catch (e) { return null; }
    },

    refreshPoint(pt) {
      if (pt.timestamp != null) pt.x = this.timeToX(pt.timestamp);
      if (pt.price != null) pt.y = this.priceToY(pt.price);
    },

    capturePoint(screenX, screenY) {
      let finalX = screenX;
      let finalY = screenY;

      if (DrawingEngine.magnetMode && window.chart && chart.candles && chart.candles.length) {
        const bestCandle = SnapEngine.findNearestOHLC(screenX, screenY);
        if (bestCandle) {
          finalX = bestCandle.x;
          finalY = bestCandle.y;
        }
      }

      const timestamp = this.xToTime(finalX);
      const price = this.yToPrice(finalY);
      return { timestamp, price, x: finalX, y: finalY };
    }
  };

  function getDrawingHandles(drawing) {
    // Helpers – 4 corners from a bounding box
    function bbCorners(bb) {
      return [
        { x: bb.minX, y: bb.minY }, // TL
        { x: bb.maxX, y: bb.minY }, // TR
        { x: bb.minX, y: bb.maxY }, // BL
        { x: bb.maxX, y: bb.maxY }  // BR
      ];
    }

    // Shapes whose handles must all live on the 4 visual bounding-box corners
    const BOX_TOOLS = [
      'rectangle', 'roundrect',
      'gannbox', 'gannsquare',
      'pricerange', 'daterange', 'dtpricerange',
      'longposition', 'shortposition',
      'regression',
      'circle', 'ellipse',
    ];
    if (BOX_TOOLS.includes(drawing.tool)) {
      const bb = getBoundingBox(drawing);
      return bbCorners(bb);
    }

    if (drawing.tool === 'channel' || drawing.tool === 'flatchannel') {
      if (drawing.points.length >= 3) {
        const [p1, p2, p3] = drawing.points;
        return [
          { x: p1.x, y: p1.y }, // 0: top-left
          { x: p2.x, y: p2.y }, // 1: top-right
          { x: p3.x, y: p3.y }, // 2: bottom-left
          { x: p3.x + p2.x - p1.x, y: p3.y + p2.y - p1.y } // 3: bottom-right
        ];
      }
    }

    return drawing.points.map(p => ({ x: p.x, y: p.y }));
  }

  function getResizeCursor(drawing, handleIndex) {
    const handles = getDrawingHandles(drawing);
    const h = handles[handleIndex];
    if (!h) return 'crosshair';

    const bb = getBoundingBox(drawing);
    const cx = bb.cx;
    const cy = bb.cy;

    const dx = h.x - cx;
    const dy = h.y - cy;

    // If it is very close to the center, just use crosshair
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return 'crosshair';

    // Check vertical / horizontal alignment
    if (Math.abs(dx) < 4) return 'ns-resize';
    if (Math.abs(dy) < 4) return 'ew-resize';

    // Diagonal quadrants
    if ((dx < 0 && dy < 0) || (dx > 0 && dy > 0)) {
      return 'nwse-resize';
    } else {
      return 'nesw-resize';
    }
  }

  function getBoundingBox(drawing) {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    // Special visual-extent bounding boxes for shapes where control points != visual bounds
    if (drawing.tool === 'circle' && drawing.points.length >= 2) {
      const [c, rPt] = drawing.points;
      const r = dist(c.x, c.y, rPt.x, rPt.y);
      minX = c.x - r; maxX = c.x + r;
      minY = c.y - r; maxY = c.y + r;
      return { minX, maxX, minY, maxY, w: maxX - minX, h: maxY - minY, cx: c.x, cy: c.y };
    }
    if (drawing.tool === 'ellipse' && drawing.points.length >= 2) {
      const [c, size] = drawing.points;
      const rx = Math.abs(size.x - c.x);
      const ry = Math.abs(size.y - c.y);
      minX = c.x - rx; maxX = c.x + rx;
      minY = c.y - ry; maxY = c.y + ry;
      return { minX, maxX, minY, maxY, w: maxX - minX, h: maxY - minY, cx: c.x, cy: c.y };
    }
    
    let pts = drawing.points.slice();
    if (drawing.tool === 'pitchfork' || drawing.tool === 'schiff' || drawing.tool === 'modschiff') {
      if (drawing.points.length >= 3) {
        const [p0, p1, p2] = drawing.points;
        let startX = p0.x;
        let startY = p0.y;
        if (drawing.tool === 'schiff') {
          startY = (p0.y + p1.y) / 2;
        } else if (drawing.tool === 'modschiff') {
          startX = p0.x + (p1.x - p0.x) / 2;
          startY = p0.y + (p1.y - p0.y) / 2;
        }
        const midX = (p1.x + p2.x) / 2;
        const midY = (p1.y + p2.y) / 2;
        const dx = midX - startX, dy = midY - startY;
        
        pts.push({ x: midX + dx * 5, y: midY + dy * 5 });
        pts.push({ x: p1.x + dx * 5, y: p1.y + dy * 5 });
        pts.push({ x: p2.x + dx * 5, y: p2.y + dy * 5 });
      }
    } else if (drawing.tool === 'channel' || drawing.tool === 'flatchannel') {
      if (drawing.points.length >= 3) {
        const [p1, p2, p3] = drawing.points;
        pts.push({ x: p3.x + p2.x - p1.x, y: p3.y + p2.y - p1.y });
      }
    }
    
    pts.forEach(p => {
      if (p.x !== null && p.y !== null && !isNaN(p.x) && !isNaN(p.y)) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
    });

    if (minX === Infinity) return { minX: 0, maxX: 0, minY: 0, maxY: 0, w: 0, h: 0, cx: 0, cy: 0 };
    if (minX === maxX) { minX -= 15; maxX += 15; }
    if (minY === maxY) { minY -= 15; maxY += 15; }

    return {
      minX, maxX, minY, maxY,
      w: maxX - minX,
      h: maxY - minY,
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2
    };
  }

  function getPointsBoundingBox(points) {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    points.forEach(p => {
      if (p.x !== null && p.x !== undefined && !isNaN(p.x)) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
      }
      if (p.y !== null && p.y !== undefined && !isNaN(p.y)) {
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
    });

    if (minX === Infinity) return { minX: 0, maxX: 0, minY: 0, maxY: 0, w: 30, h: 30 };
    if (minX === maxX) { minX -= 15; maxX += 15; }
    if (minY === maxY) { minY -= 15; maxY += 15; }

    return { minX, maxX, minY, maxY, w: maxX - minX, h: maxY - minY };
  }

  // ============================================================
  // SNAP ENGINE
  // ============================================================
  const SnapEngine = {
    findNearestOHLC(screenX, screenY) {
      const ch = window.chart;
      if (!ch || !ch.candles || !ch.candles.length) return null;

      let nearestCandle = null;
      let minDistanceX = Infinity;
      let targetX = screenX;

      ch.candles.forEach(c => {
        const timeSec = Math.floor(normalizeTime(c.time) / 1000);
        const cx = ch.tvChart.timeScale().timeToCoordinate(timeSec);
        if (cx !== null && cx !== undefined) {
          const dx = Math.abs(cx - screenX);
          if (dx < minDistanceX) {
            minDistanceX = dx;
            nearestCandle = c;
            targetX = cx;
          }
        }
      });

      if (!nearestCandle) return null;

      const activeSeries = ch.candlestickSeries || ch.areaSeries || ch.barSeries;
      if (!activeSeries) return null;

      const yO = activeSeries.priceToCoordinate(nearestCandle.open);
      const yH = activeSeries.priceToCoordinate(nearestCandle.high);
      const yL = activeSeries.priceToCoordinate(nearestCandle.low);
      const yC = activeSeries.priceToCoordinate(nearestCandle.close);

      const targets = [
        { y: yO, val: nearestCandle.open },
        { y: yH, val: nearestCandle.high },
        { y: yL, val: nearestCandle.low },
        { y: yC, val: nearestCandle.close }
      ].filter(t => t.y !== null && t.y !== undefined);

      let bestY = screenY;
      let minDistanceY = Infinity;

      targets.forEach(t => {
        const dy = Math.abs(t.y - screenY);
        if (dy < minDistanceY) {
          minDistanceY = dy;
          bestY = t.y;
        }
      });

      return { x: targetX, y: bestY };
    }
  };

  // ============================================================
  // DRAWING OBJECT — Abstract Base Class
  // ============================================================
  class DrawingObject {
    constructor(tool) {
      this.id = uid();
      this.tool = tool;
      this.points = []; 
      this.style = StyleManager.defaultStyle();
      this.locked = false;
      this.hidden = false;
      this.selected = false;
      this.complete = false;
      this.layer = 0; 
      this.groupId = null;
      this.label = '';
      this.createdDate = Date.now();
      this.modifiedDate = Date.now();
      this.version = '2.0.0';
    }

    refresh() {
      for (const pt of this.points) {
        CoordinateConverter.refreshPoint(pt);
      }
    }

    isVisible(viewportW, viewportH) {
      if (this.hidden) return false;
      if (!this.points.length) return false;
      
      let hasValidCoords = false;
      for (const pt of this.points) {
        if (pt.x !== null && pt.y !== null) {
          hasValidCoords = true;
          break;
        }
      }
      return hasValidCoords;
    }

    hitTest(px, py, threshold = 8) { return false; }
    getHandles() { return this.points.map(p => ({ x: p.x, y: p.y })); }

    toJSON() {
      return {
        id: this.id,
        tool: this.tool,
        points: this.points.map(p => ({ timestamp: p.timestamp, price: p.price })),
        style: { ...this.style },
        locked: this.locked,
        hidden: this.hidden,
        layer: this.layer,
        groupId: this.groupId,
        label: this.label,
        createdDate: this.createdDate,
        modifiedDate: this.modifiedDate,
        version: this.version
      };
    }

    fromJSON(obj) {
      this.id = obj.id || uid();
      this.points = obj.points.map(p => ({ timestamp: p.timestamp, price: p.price, x: null, y: null }));
      this.style = { ...StyleManager.defaultStyle(), ...obj.style };
      this.locked = obj.locked || false;
      this.hidden = obj.hidden || false;
      this.layer = obj.layer || 0;
      this.groupId = obj.groupId || null;
      this.label = obj.label || '';
      this.createdDate = obj.createdDate || Date.now();
      this.modifiedDate = obj.modifiedDate || Date.now();
      this.complete = true;
      this.refresh();
    }

    moveBy(dx, dy) {
      if (this.locked) return;
      this.modifiedDate = Date.now();
      for (const pt of this.points) {
        pt.x = (pt.x || 0) + dx;
        pt.y = (pt.y || 0) + dy;
      }
    }

    moveHandle(index, newX, newY) {
      if (this.locked || index >= this.points.length) return;
      this.modifiedDate = Date.now();
      const pt = this.points[index];
      pt.x = newX;
      pt.y = newY;
    }
  }

  // ============================================================
  // 30+ DRAWING TOOLS IMPLEMENTATION
  // ============================================================

  // --- Basic Lines ---
  class TrendLine extends DrawingObject {
    constructor() { super('trendline'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 2) return false;
      return pointToSegmentDist(px, py, this.points[0].x, this.points[0].y, this.points[1].x, this.points[1].y) <= threshold;
    }
  }

  class Ray extends DrawingObject {
    constructor() { super('ray'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 2) return false;
      return pointToRayDist(px, py, this.points[0].x, this.points[0].y, this.points[1].x, this.points[1].y) <= threshold;
    }
  }

  class ExtendedLine extends DrawingObject {
    constructor() { super('extline'); }
    _getInfinitePoints(w, h) {
      if (this.points.length < 2) return null;
      const [p1, p2] = this.points;
      const dx = p2.x - p1.x, dy = p2.y - p1.y;
      if (Math.abs(dx) < 0.001) {
        return { x1: p1.x, y1: 0, x2: p1.x, y2: h };
      }
      const slope = dy / dx;
      const MathIntercept = p1.y - slope * p1.x;
      return { x1: 0, y1: MathIntercept, x2: w, y2: slope * w + MathIntercept };
    }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 2) return false;
      const pts = this._getInfinitePoints(10000, 10000);
      if (!pts) return false;
      return pointToSegmentDist(px, py, pts.x1, pts.y1, pts.x2, pts.y2) <= threshold;
    }
  }

  class HorizontalLine extends DrawingObject {
    constructor() { super('hline'); }
    hitTest(px, py, threshold = 8) {
      if (!this.points.length) return false;
      return Math.abs(py - this.points[0].y) <= threshold;
    }
    getHandles() {
      const canvas = document.getElementById('gxm-drawing-canvas');
      const w = canvas ? canvas.width : 800;
      return [{ x: w / 2, y: this.points[0].y }];
    }
  }

  class HorizontalRay extends DrawingObject {
    constructor() { super('hray'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 2) return false;
      const [p1, p2] = this.points;
      if (px < p1.x) return false;
      return Math.abs(py - p1.y) <= threshold;
    }
  }

  class VerticalLine extends DrawingObject {
    constructor() { super('vline'); }
    hitTest(px, py, threshold = 8) {
      if (!this.points.length) return false;
      return Math.abs(px - this.points[0].x) <= threshold;
    }
    getHandles() {
      const canvas = document.getElementById('gxm-drawing-canvas');
      const h = canvas ? canvas.height : 400;
      return [{ x: this.points[0].x, y: h / 2 }];
    }
  }

  class VerticalRay extends DrawingObject {
    constructor() { super('vray'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 2) return false;
      const [p1, p2] = this.points;
      if (py < p1.y) return false;
      return Math.abs(px - p1.x) <= threshold;
    }
  }

  class CrossLine extends DrawingObject {
    constructor() { super('crossline'); }
    hitTest(px, py, threshold = 8) {
      if (!this.points.length) return false;
      return Math.abs(px - this.points[0].x) <= threshold || Math.abs(py - this.points[0].y) <= threshold;
    }
  }

  // --- Shapes ---
  class RectangleTool extends DrawingObject {
    constructor() { super('rectangle'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 2) return false;
      const [p1, p2] = this.points;
      const x1 = Math.min(p1.x, p2.x), x2 = Math.max(p1.x, p2.x);
      const y1 = Math.min(p1.y, p2.y), y2 = Math.max(p1.y, p2.y);
      return px >= x1 - threshold && px <= x2 + threshold && py >= y1 - threshold && py <= y2 + threshold;
    }
  }

  class RoundedRectangleTool extends DrawingObject {
    constructor() { super('roundrect'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 2) return false;
      const [p1, p2] = this.points;
      const x1 = Math.min(p1.x, p2.x), x2 = Math.max(p1.x, p2.x);
      const y1 = Math.min(p1.y, p2.y), y2 = Math.max(p1.y, p2.y);
      return px >= x1 - threshold && px <= x2 + threshold && py >= y1 - threshold && py <= y2 + threshold;
    }
  }

  class TriangleTool extends DrawingObject {
    constructor() { super('triangle'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 3) return false;
      const [p1, p2, p3] = this.points;
      return pointToSegmentDist(px, py, p1.x, p1.y, p2.x, p2.y) <= threshold ||
             pointToSegmentDist(px, py, p2.x, p2.y, p3.x, p3.y) <= threshold ||
             pointToSegmentDist(px, py, p3.x, p3.y, p1.x, p1.y) <= threshold ||
             pointInPolygon(px, py, this.points);
    }
  }

  class PolygonTool extends DrawingObject {
    constructor() { super('polygon'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 2) return false;
      for (let i = 0; i < this.points.length; i++) {
        const next = this.points[(i + 1) % this.points.length];
        if (pointToSegmentDist(px, py, this.points[i].x, this.points[i].y, next.x, next.y) <= threshold) return true;
      }
      return pointInPolygon(px, py, this.points);
    }
  }

  class CurveTool extends DrawingObject {
    constructor() { super('curve'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 3) return false;
      const [p1, ctrl, p2] = this.points;
      for (let t = 0; t <= 1; t += 0.05) {
        const cx = (1 - t) ** 2 * p1.x + 2 * (1 - t) * t * ctrl.x + t ** 2 * p2.x;
        const cy = (1 - t) ** 2 * p1.y + 2 * (1 - t) * t * ctrl.y + t ** 2 * p2.y;
        if (dist(px, py, cx, cy) <= threshold) return true;
      }
      return false;
    }
  }

  class ArcTool extends DrawingObject {
    constructor() { super('arc'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 3) return false;
      const [p1, p2, p3] = this.points;
      for (let t = 0; t <= 1; t += 0.05) {
        const cx = (1 - t) ** 2 * p1.x + 2 * (1 - t) * t * p3.x + t ** 2 * p2.x;
        const cy = (1 - t) ** 2 * p1.y + 2 * (1 - t) * t * p3.y + t ** 2 * p2.y;
        if (dist(px, py, cx, cy) <= threshold) return true;
      }
      return false;
    }
  }

  class CircleTool extends DrawingObject {
    constructor() { super('circle'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 2) return false;
      const [c, rPt] = this.points;
      const r = dist(c.x, c.y, rPt.x, rPt.y);
      const d = dist(px, py, c.x, c.y);
      return Math.abs(d - r) <= threshold || d <= r;
    }
  }

  class EllipseTool extends DrawingObject {
    constructor() { super('ellipse'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 2) return false;
      const [c, size] = this.points;
      const rx = Math.abs(size.x - c.x);
      const ry = Math.abs(size.y - c.y);
      if (rx === 0 || ry === 0) return false;
      const norm = ((px - c.x) / rx) ** 2 + ((py - c.y) / ry) ** 2;
      return norm <= 1.1; 
    }
  }

  // --- Channels ---
  class ParallelChannel extends DrawingObject {
    constructor() { super('channel'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 3) return false;
      const [p1, p2, p3] = this.points;
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const p4 = { x: p3.x + dx, y: p3.y + dy };
      
      const onLine1 = pointToSegmentDist(px, py, p1.x, p1.y, p2.x, p2.y) <= threshold;
      const onLine2 = pointToSegmentDist(px, py, p3.x, p3.y, p4.x, p4.y) <= threshold;
      return onLine1 || onLine2 || pointInPolygon(px, py, [
        { x: p1.x, y: p1.y }, { x: p2.x, y: p2.y },
        { x: p4.x, y: p4.y }, { x: p3.x, y: p3.y }
      ]);
    }
  }

  class DisjointChannel extends DrawingObject {
    constructor() { super('disjointchannel'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 4) return false;
      const [p1, p2, p3, p4] = this.points;
      const line1 = pointToSegmentDist(px, py, p1.x, p1.y, p2.x, p2.y) <= threshold;
      const line2 = pointToSegmentDist(px, py, p3.x, p3.y, p4.x, p4.y) <= threshold;
      return line1 || line2;
    }
  }

  class RegressionChannel extends DrawingObject {
    constructor() { super('regression'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 2) return false;
      const [p1, p2] = this.points;
      const x1 = Math.min(p1.x, p2.x), x2 = Math.max(p1.x, p2.x);
      return px >= x1 && px <= x2 && Math.abs(py - (p1.y + p2.y) / 2) <= 100;
    }
  }

  class FlatTopBottomChannel extends DrawingObject {
    constructor() { super('flatchannel'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 3) return false;
      const [p1, p2, p3] = this.points;
      const line1 = pointToSegmentDist(px, py, p1.x, p1.y, p2.x, p2.y) <= threshold;
      const line2 = Math.abs(py - p3.y) <= threshold && px >= Math.min(p1.x, p2.x) && px <= Math.max(p1.x, p2.x);
      return line1 || line2;
    }
  }

  // --- Fibonacci Tools ---
  class FibonacciRetracement extends DrawingObject {
    constructor() {
      super('fibonacci');
      this.levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0, 1.618];
    }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 2) return false;
      const [p1, p2] = this.points;
      for (const lvl of this.levels) {
        const y = p1.y + (p2.y - p1.y) * lvl;
        if (Math.abs(py - y) <= threshold) return true;
      }
      return false;
    }
  }

  class FibonacciExtension extends DrawingObject {
    constructor() {
      super('fibext');
      this.levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0, 1.618];
    }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 3) return false;
      const [p1, p2, p3] = this.points;
      const baseDiff = p2.y - p1.y;
      for (const lvl of this.levels) {
        const y = p3.y + baseDiff * lvl;
        if (Math.abs(py - y) <= threshold) return true;
      }
      return false;
    }
  }

  class FibonacciFan extends DrawingObject {
    constructor() { super('fibfan'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 2) return false;
      const [p1, p2] = this.points;
      const levels = [0.382, 0.5, 0.618];
      for (const lvl of levels) {
        const targetY = p1.y + (p2.y - p1.y) * lvl;
        if (pointToRayDist(px, py, p1.x, p1.y, p2.x, targetY) <= threshold) return true;
      }
      return false;
    }
  }

  class FibonacciArc extends DrawingObject {
    constructor() { super('fibarc'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 2) return false;
      const [p1, p2] = this.points;
      const radius = dist(p1.x, p1.y, p2.x, p2.y);
      const levels = [0.382, 0.5, 0.618, 1.0];
      const d = dist(px, py, p1.x, p1.y);
      for (const lvl of levels) {
        if (Math.abs(d - radius * lvl) <= threshold) return true;
      }
      return false;
    }
  }

  class FibonacciTimeZones extends DrawingObject {
    constructor() { super('fibtz'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 2) return false;
      const [p1, p2] = this.points;
      const baseWidth = p2.x - p1.x;
      const zones = [1, 2, 3, 5, 8, 13, 21, 34];
      for (const z of zones) {
        const zx = p1.x + baseWidth * z;
        if (Math.abs(px - zx) <= threshold) return true;
      }
      return false;
    }
  }

  // --- Gann Tools ---
  class GannBox extends DrawingObject {
    constructor() { super('gannbox'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 2) return false;
      const [p1, p2] = this.points;
      const x1 = Math.min(p1.x, p2.x), x2 = Math.max(p1.x, p2.x);
      const y1 = Math.min(p1.y, p2.y), y2 = Math.max(p1.y, p2.y);
      return px >= x1 - threshold && px <= x2 + threshold && py >= y1 - threshold && py <= y2 + threshold;
    }
  }

  class GannFan extends DrawingObject {
    constructor() { super('gannfan'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 2) return false;
      const [p1, p2] = this.points;
      const angles = [1/8, 1/4, 1/3, 1/2, 1, 2, 3, 4, 8];
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      for (const a of angles) {
        if (pointToRayDist(px, py, p1.x, p1.y, p1.x + dx, p1.y + dy * a) <= threshold) return true;
      }
      return false;
    }
  }

  class GannSquare extends DrawingObject {
    constructor() { super('gannsquare'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 2) return false;
      const [p1, p2] = this.points;
      const size = Math.max(Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
      const x2 = p1.x + (p2.x > p1.x ? size : -size);
      const y2 = p1.y + (p2.y > p1.y ? size : -size);
      return px >= Math.min(p1.x, x2) && px <= Math.max(p1.x, x2) &&
             py >= Math.min(p1.y, y2) && py <= Math.max(p1.y, y2);
    }
  }

  // --- Measurement Tools ---
  class PriceRange extends DrawingObject {
    constructor() { super('pricerange'); }
    getRange() {
      if (this.points.length < 2) return null;
      return {
        high: Math.max(this.points[0].price, this.points[1].price),
        low: Math.min(this.points[0].price, this.points[1].price)
      };
    }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 2) return false;
      const [p1, p2] = this.points;
      const x1 = Math.min(p1.x, p2.x), x2 = Math.max(p1.x, p2.x);
      const y1 = Math.min(p1.y, p2.y), y2 = Math.max(p1.y, p2.y);
      return px >= x1 - threshold && px <= x2 + threshold && py >= y1 - threshold && py <= y2 + threshold;
    }
  }

  class DateRange extends DrawingObject {
    constructor() { super('daterange'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 2) return false;
      const [p1, p2] = this.points;
      const x1 = Math.min(p1.x, p2.x), x2 = Math.max(p1.x, p2.x);
      return px >= x1 - threshold && px <= x2 + threshold && Math.abs(py - (p1.y + p2.y)/2) <= 30;
    }
  }

  class DatePriceRange extends DrawingObject {
    constructor() { super('dtpricerange'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 2) return false;
      const [p1, p2] = this.points;
      const x1 = Math.min(p1.x, p2.x), x2 = Math.max(p1.x, p2.x);
      const y1 = Math.min(p1.y, p2.y), y2 = Math.max(p1.y, p2.y);
      return px >= x1 - threshold && px <= x2 + threshold && py >= y1 - threshold && py <= y2 + threshold;
    }
  }

  class TrendAngle extends DrawingObject {
    constructor() { super('trendangle'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 2) return false;
      return pointToSegmentDist(px, py, this.points[0].x, this.points[0].y, this.points[1].x, this.points[1].y) <= threshold;
    }
  }

  class LongPosition extends DrawingObject {
    constructor() { super('longposition'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 3) return false;
      const [entry, target, stop] = this.points;
      const x1 = entry.x, x2 = Math.max(target.x, stop.x);
      return px >= Math.min(x1, x2) && px <= Math.max(x1, x2) && py >= Math.min(target.y, stop.y) && py <= Math.max(target.y, stop.y);
    }
  }

  class ShortPosition extends DrawingObject {
    constructor() { super('shortposition'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 3) return false;
      const [entry, target, stop] = this.points;
      const x1 = entry.x, x2 = Math.max(target.x, stop.x);
      return px >= Math.min(x1, x2) && px <= Math.max(x1, x2) && py >= Math.min(target.y, stop.y) && py <= Math.max(target.y, stop.y);
    }
  }

  // --- Time Analysis ---
  class CyclicLines extends DrawingObject {
    constructor() { super('cycliclines'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 2) return false;
      const [p1, p2] = this.points;
      const cycleWidth = Math.abs(p2.x - p1.x);
      if (cycleWidth < 5) return false;
      const dx = px - p1.x;
      const remainder = dx % cycleWidth;
      return Math.abs(remainder) <= threshold || Math.abs(cycleWidth - Math.abs(remainder)) <= threshold;
    }
  }

  class TimeCycles extends DrawingObject {
    constructor() { super('timecycles'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 2) return false;
      const [p1, p2] = this.points;
      const cycleWidth = Math.abs(p2.x - p1.x);
      if (cycleWidth < 5) return false;
      const dx = px - p1.x;
      const remainder = dx % cycleWidth;
      return Math.abs(remainder) <= threshold || Math.abs(cycleWidth - Math.abs(remainder)) <= threshold;
    }
  }

  class SessionBoxes extends DrawingObject {
    constructor() { super('sessionboxes'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 2) return false;
      const [p1, p2] = this.points;
      const x1 = Math.min(p1.x, p2.x), x2 = Math.max(p1.x, p2.x);
      const y1 = Math.min(p1.y, p2.y), y2 = Math.max(p1.y, p2.y);
      return px >= x1 - threshold && px <= x2 + threshold && py >= y1 - threshold && py <= y2 + threshold;
    }
  }

  // --- Annotation Tools ---
  class TextTool extends DrawingObject {
    constructor() { super('text'); }
    hitTest(px, py, threshold = 8) {
      if (!this.points.length) return false;
      const pt = this.points[0];
      return dist(px, py, pt.x, pt.y) <= 15;
    }
  }

  class RichTextTool extends DrawingObject {
    constructor() { super('richtext'); }
    hitTest(px, py, threshold = 8) {
      if (!this.points.length) return false;
      const pt = this.points[0];
      return dist(px, py, pt.x, pt.y) <= 15;
    }
  }

  class ArrowTool extends DrawingObject {
    constructor() { super('arrow'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 2) return false;
      return pointToSegmentDist(px, py, this.points[0].x, this.points[0].y, this.points[1].x, this.points[1].y) <= threshold;
    }
  }

  class CalloutTool extends DrawingObject {
    constructor() { super('callout'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 2) return false;
      return pointToSegmentDist(px, py, this.points[0].x, this.points[0].y, this.points[1].x, this.points[1].y) <= threshold;
    }
  }

  class NoteTool extends DrawingObject {
    constructor() { super('note'); }
    hitTest(px, py, threshold = 8) {
      if (!this.points.length) return false;
      return dist(px, py, this.points[0].x, this.points[0].y) <= 15;
    }
  }

  class IconTool extends DrawingObject {
    constructor() { super('icon'); }
    hitTest(px, py, threshold = 8) {
      if (!this.points.length) return false;
      return dist(px, py, this.points[0].x, this.points[0].y) <= 15;
    }
  }

  class EmojiMarker extends DrawingObject {
    constructor() { super('emoji'); }
    hitTest(px, py, threshold = 8) {
      if (!this.points.length) return false;
      return dist(px, py, this.points[0].x, this.points[0].y) <= 15;
    }
  }

  // --- Pattern Drawings ---
  class AndrewsPitchfork extends DrawingObject {
    constructor() { super('pitchfork'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 3) return false;
      const [p0, p1, p2] = this.points;
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      if (pointToSegmentDist(px, py, p0.x, p0.y, midX, midY) <= threshold) return true;
      if (pointToRayDist(px, py, midX, midY, p1.x, p1.y) <= threshold) return true;
      if (pointToRayDist(px, py, midX, midY, p2.x, p2.y) <= threshold) return true;
      return false;
    }
  }

  class SchiffPitchfork extends DrawingObject {
    constructor() { super('schiff'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 3) return false;
      const [p0, p1, p2] = this.points;
      const adjP0x = p0.x;
      const adjP0y = (p0.y + p1.y) / 2;
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      return pointToSegmentDist(px, py, adjP0x, adjP0y, midX, midY) <= threshold;
    }
  }

  class ModifiedSchiffPitchfork extends DrawingObject {
    constructor() { super('modschiff'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 3) return false;
      const [p0, p1, p2] = this.points;
      const halfDx = (p1.x - p0.x) / 2;
      const halfDy = (p1.y - p0.y) / 2;
      const adjP0x = p0.x + halfDx;
      const adjP0y = p0.y + halfDy;
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      return pointToSegmentDist(px, py, adjP0x, adjP0y, midX, midY) <= threshold;
    }
  }

  class ElliottWave extends DrawingObject {
    constructor() { super('elliott'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 2) return false;
      for (let i = 0; i < this.points.length - 1; i++) {
        if (pointToSegmentDist(px, py, this.points[i].x, this.points[i].y, this.points[i+1].x, this.points[i+1].y) <= threshold) return true;
      }
      return false;
    }
  }

  class HarmonicPattern extends DrawingObject {
    constructor() { super('harmonic'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 2) return false;
      for (let i = 0; i < this.points.length; i++) {
        const next = this.points[(i + 1) % this.points.length];
        if (pointToSegmentDist(px, py, this.points[i].x, this.points[i].y, next.x, next.y) <= threshold) return true;
      }
      return pointInPolygon(px, py, this.points);
    }
  }

  class ABCDPattern extends DrawingObject {
    constructor() { super('abcd'); }
    hitTest(px, py, threshold = 8) {
      if (this.points.length < 2) return false;
      for (let i = 0; i < this.points.length - 1; i++) {
        if (pointToSegmentDist(px, py, this.points[i].x, this.points[i].y, this.points[i+1].x, this.points[i+1].y) <= threshold) return true;
      }
      return false;
    }
  }

  const TOOL_CLASSES = {
    trendline: TrendLine,
    ray: Ray,
    extline: ExtendedLine,
    hline: HorizontalLine,
    hray: HorizontalRay,
    vline: VerticalLine,
    vray: VerticalRay,
    crossline: CrossLine,
    rectangle: RectangleTool,
    roundrect: RoundedRectangleTool,
    triangle: TriangleTool,
    polygon: PolygonTool,
    curve: CurveTool,
    arc: ArcTool,
    circle: CircleTool,
    ellipse: EllipseTool,
    channel: ParallelChannel,
    disjointchannel: DisjointChannel,
    regression: RegressionChannel,
    flatchannel: FlatTopBottomChannel,
    fibonacci: FibonacciRetracement,
    fibext: FibonacciExtension,
    fibfan: FibonacciFan,
    fibarc: FibonacciArc,
    fibtz: FibonacciTimeZones,
    gannbox: GannBox,
    gannfan: GannFan,
    gannsquare: GannSquare,
    pricerange: PriceRange,
    daterange: DateRange,
    dtpricerange: DatePriceRange,
    trendangle: TrendAngle,
    longposition: LongPosition,
    shortposition: ShortPosition,
    cycliclines: CyclicLines,
    timecycles: TimeCycles,
    sessionboxes: SessionBoxes,
    text: TextTool,
    richtext: RichTextTool,
    arrow: ArrowTool,
    callout: CalloutTool,
    note: NoteTool,
    icon: IconTool,
    emoji: EmojiMarker,
    pitchfork: AndrewsPitchfork,
    schiff: SchiffPitchfork,
    modschiff: ModifiedSchiffPitchfork,
    elliott: ElliottWave,
    harmonic: HarmonicPattern,
    abcd: ABCDPattern
  };

  const TOOL_ANCHOR_COUNT = {
    trendline: 2, ray: 2, extline: 2, hline: 1, hray: 2, vline: 1, vray: 2, crossline: 1,
    rectangle: 2, roundrect: 2, triangle: 3, polygon: 99, curve: 3, arc: 3, circle: 2, ellipse: 2,
    channel: 3, disjointchannel: 4, regression: 2, flatchannel: 3,
    fibonacci: 2, fibext: 3, fibfan: 2, fibarc: 2, fibtz: 2,
    gannbox: 2, gannfan: 2, gannsquare: 2,
    pricerange: 2, daterange: 2, dtpricerange: 2, trendangle: 2, longposition: 3, shortposition: 3,
    cycliclines: 2, timecycles: 2, sessionboxes: 2,
    text: 1, richtext: 1, arrow: 2, callout: 2, note: 1, icon: 1, emoji: 1,
    pitchfork: 3, schiff: 3, modschiff: 3, elliott: 5, harmonic: 5, abcd: 4
  };

  // ============================================================
  // STYLE MANAGER & THEME MANAGER
  // ============================================================
  const StyleManager = {
    defaultStyle() {
      return {
        color: '#1ab76d',
        opacity: 0.85,
        lineWidth: 2,
        lineStyle: 'solid', 
        fillColor: 'rgba(26,183,109,0.08)',
        textColor: '#e2e8f0',
        fontSize: 11,
        glow: false,
        shadow: false,
        labelVisible: true,
        labelPosition: 'top'
      };
    },

    applyStroke(ctx, style) {
      ctx.strokeStyle = this._colorWithOpacity(style.color, style.opacity);
      ctx.lineWidth = style.lineWidth;
      
      if (style.lineStyle === 'dashed') {
        ctx.setLineDash([8, 4]);
      } else if (style.lineStyle === 'dotted') {
        ctx.setLineDash([2, 3]);
      } else {
        ctx.setLineDash([]);
      }

      if (style.shadow) {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
        ctx.shadowBlur = 4;
        ctx.shadowOffsetX = 2;
        ctx.shadowOffsetY = 2;
      } else {
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
      }
    },

    _colorWithOpacity(color, opacity) {
      if (opacity >= 1 && !color.startsWith('rgba')) return color;
      let r = 26, g = 183, b = 109;
      if (color.startsWith('#') && color.length === 7) {
        r = parseInt(color.slice(1, 3), 16);
        g = parseInt(color.slice(3, 5), 16);
        b = parseInt(color.slice(5, 7), 16);
      }
      return `rgba(${r},${g},${b},${opacity})`;
    }
  };

  // ============================================================
  // HIT TEST ENGINE
  // ============================================================
  const HitTestEngine = {
    THRESHOLD: 9,
    HANDLE_RADIUS: 7,

    findHit(drawings, px, py) {
      const sorted = [...drawings].sort((a, b) => b.layer - a.layer);
      for (const d of sorted) {
        if (d.hidden) continue;
        if (d.hitTest(px, py, this.THRESHOLD)) return d;
      }
      return null;
    },

    findHandle(drawing, px, py, cornerTolerance = 10, centerTolerance = 12) {
      const handles = getDrawingHandles(drawing);
      for (let i = 0; i < handles.length; i++) {
        const h = handles[i];
        if (h.x !== null && h.y !== null && !isNaN(h.x) && !isNaN(h.y)) {
          if (dist(px, py, h.x, h.y) <= cornerTolerance) {
            return i; 
          }
        }
      }

      const bb = getBoundingBox(drawing);
      if (bb.w > 0 || bb.h > 0) {
        if (dist(px, py, bb.cx, bb.cy) <= centerTolerance) {
          return 99; // 99 represents the move handle
        }
      }

      return -1;
    }
  };

  // ============================================================
  // DRAWING HISTORY — Undo / Redo
  // ============================================================
  const DrawingHistory = {
    _states: [[]],
    _index: 0,
    MAX: 100,

    init(initialDrawings) {
      const state = (initialDrawings || []).map(d => d.toJSON());
      this._states = [state];
      this._index = 0;
      this._updateUI();
    },

    snapshot(drawings) {
      this._states = this._states.slice(0, this._index + 1);
      const state = drawings.map(d => d.toJSON());
      this._states.push(state);
      if (this._states.length > this.MAX) {
        this._states.shift();
      } else {
        this._index++;
      }
      this._updateUI();
    },

    undo(manager) {
      if (this._index > 0) {
        this._index--;
        const prev = this._states[this._index];
        this._restore(manager, prev);
        this._updateUI();
      }
    },

    redo(manager) {
      if (this._index < this._states.length - 1) {
        this._index++;
        const next = this._states[this._index];
        this._restore(manager, next);
        this._updateUI();
      }
    },

    _restore(manager, state) {
      manager.drawings = state.map(obj => {
        const Cls = TOOL_CLASSES[obj.tool];
        if (!Cls) return null;
        const inst = new Cls();
        inst.fromJSON(obj);
        return inst;
      }).filter(Boolean);
      DrawingRenderer.markDirty();
      DrawingStorage.save(manager.drawings);
    },

    _updateUI() {
      const btnUndo = document.getElementById('gxm-draw-undo');
      const btnRedo = document.getElementById('gxm-draw-redo');
      if (btnUndo) btnUndo.disabled = this._index === 0;
      if (btnRedo) btnRedo.disabled = this._index === this._states.length - 1;
    },

    clear() {
      this._states = [[]];
      this._index = 0;
      this._updateUI();
    }
  };

  // ============================================================
  // DRAWING STORAGE — localStorage
  // ============================================================
  const DrawingStorage = {
    KEY: 'gxm_drawings_v2',

    save(drawings) {
      try {
        const data = drawings.map(d => d.toJSON());
        localStorage.setItem(this.KEY, JSON.stringify(data));
      } catch (e) {}
    },

    load() {
      try {
        const raw = localStorage.getItem(this.KEY);
        if (!raw) return [];
        const data = JSON.parse(raw);
        return data.map(obj => {
          const Cls = TOOL_CLASSES[obj.tool];
          if (!Cls) return null;
          const inst = new Cls();
          inst.fromJSON(obj);
          return inst;
        }).filter(Boolean);
      } catch (e) { return []; }
    },

    clear() {
      localStorage.removeItem(this.KEY);
    }
  };

  // ============================================================
  // DRAWING RENDERER (60 FPS, Viewport Culled)
  // ============================================================
  const DrawingRenderer = {
    _dirty: true,
    _rafId: null,
    _canvas: null,
    _ctx: null,
    _manager: null,

    init(manager) {
      this._manager = manager;
      this._ensureCanvas();
      this._ensureQuickDeleteButton(manager);
      this._loop();
    },

    _ensureCanvas() {
      let canvas = document.getElementById('gxm-drawing-canvas');
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.id = 'gxm-drawing-canvas';
        canvas.style.cssText = `
          position: absolute;
          top: 0; left: 0;
          pointer-events: none;
          z-index: 48;
          display: block;
        `;
        const container = document.getElementById('gainex-chart');
        if (container) container.appendChild(canvas);
      }
      this._canvas = canvas;
      this._ctx = canvas.getContext('2d');
      this._resize();
    },

    _ensureQuickDeleteButton(manager) {
      const container = document.getElementById('gainex-chart');
      if (!container) return;
      let btn = document.getElementById('gxm-quick-delete-btn');
      if (!btn) {
        btn = document.createElement('button');
        btn.id = 'gxm-quick-delete-btn';
        btn.type = 'button';
        btn.innerHTML = '✕';
        btn.style.cssText = `
          position: absolute;
          z-index: 1000;
          display: none;
          width: 22px;
          height: 22px;
          border-radius: 50%;
          background: #ef4444;
          border: 1.5px solid #ffffff;
          color: #ffffff;
          font-size: 11px;
          font-weight: 800;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          padding: 0;
          box-shadow: 0 3px 8px rgba(0,0,0,0.5);
          transition: transform 0.1s ease, background 0.1s ease;
        `;
        btn.addEventListener('mousedown', (e) => e.stopPropagation());
        btn.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
        
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          manager.deleteSelected();
          this.markDirty();
          btn.style.display = 'none';
        });
        container.appendChild(btn);
      }
    },

    _resize() {
      const container = document.getElementById('gainex-chart');
      if (!container || !this._canvas) return;
      const mainCanvas = container.querySelector('canvas');
      if (mainCanvas) {
        const rect = mainCanvas.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        this._canvas.style.left = `${rect.left - containerRect.left}px`;
        this._canvas.style.top  = `${rect.top  - containerRect.top}px`;
        const dpr = window.devicePixelRatio || 1;
        const w = rect.width, h = rect.height;
        if (this._canvas.width !== Math.round(w * dpr) || this._canvas.height !== Math.round(h * dpr)) {
          this._canvas.width  = Math.round(w * dpr);
          this._canvas.height = Math.round(h * dpr);
          this._canvas.style.width  = `${w}px`;
          this._canvas.style.height = `${h}px`;
          this._ctx.scale(dpr, dpr);
        }
      }
    },

    markDirty() {
      this._dirty = true;
      if (!this._rafPending) {
        this._rafPending = true;
        requestAnimationFrame(() => {
          this._rafPending = false;
          if (this._dirty) {
            this._dirty = false;
            this._render();
          }
        });
      }
    },

    _loop() {
      if (this._dirty) {
        this._dirty = false;
        this._render();
      }
    },

    _render() {
      const ctx = this._ctx;
      if (!ctx || !this._canvas) return;
      const w = this._canvas.clientWidth || this._canvas.offsetWidth;
      const h = this._canvas.clientHeight || this._canvas.offsetHeight;
      ctx.clearRect(0, 0, w, h);

      const manager = this._manager;
      if (!manager) return;

      for (const d of manager.drawings) {
        if (d !== manager.draggedDrawing) {
          d.refresh();
        }
      }

      const visibleDrawings = manager.drawings.filter(d => d.isVisible(w, h));

      visibleDrawings.forEach(d => {
        if (d.complete) this._drawObject(ctx, d, w, h);
      });

      if (manager.current) {
        manager.current.refresh();
        this._drawObject(ctx, manager.current, w, h, true);
        if (manager.current.points.length > 0 && manager._cursor) {
          this._drawPreview(ctx, manager.current, manager._cursor, w, h);
        }
      }

      visibleDrawings.forEach(d => {
        if (d.selected) this._drawHandles(ctx, d);
      });

      // Position the quick delete overlay button next to the selected drawing
      const selected = manager.selectedDrawing;
      const qdBtn = document.getElementById('gxm-quick-delete-btn');
      if (qdBtn) {
        if (selected && !selected.locked) {
          const bb = getBoundingBox(selected);
          if (bb && bb.w > 0 && bb.h > 0) {
            const x = bb.maxX + 6;
            const y = bb.minY - 14;
            qdBtn.style.left = `${x}px`;
            qdBtn.style.top = `${y}px`;
            qdBtn.style.setProperty('display', 'flex', 'important');
          } else {
            qdBtn.style.setProperty('display', 'none', 'important');
          }
        } else {
          qdBtn.style.setProperty('display', 'none', 'important');
        }
      }
    },

    _drawObject(ctx, d, w, h, inProgress) {
      const style = d.style;
      ctx.save();
      ctx.globalAlpha = style.opacity;
      StyleManager.applyStroke(ctx, style);

      switch (d.tool) {
        case 'trendline':
        case 'ray':
        case 'hray':
        case 'vray':
        case 'arrow':
          this._renderLineSegment(ctx, d, w, h);
          break;
        case 'extline':
          this._renderExtendedLine(ctx, d, w, h);
          break;
        case 'hline':
          this._renderHLine(ctx, d, w, h);
          break;
        case 'vline':
          this._renderVLine(ctx, d, w, h);
          break;
        case 'crossline':
          this._renderCrossLine(ctx, d, w, h);
          break;
        case 'rectangle':
        case 'sessionboxes':
          this._renderRect(ctx, d, style);
          break;
        case 'roundrect':
          this._renderRoundRect(ctx, d, style);
          break;
        case 'triangle':
        case 'polygon':
        case 'harmonic':
          this._renderPolygon(ctx, d, style);
          break;
        case 'curve':
          this._renderCurve(ctx, d);
          break;
        case 'arc':
          this._renderArc(ctx, d);
          break;
        case 'circle':
          this._renderCircle(ctx, d, style);
          break;
        case 'ellipse':
          this._renderEllipse(ctx, d, style);
          break;
        case 'channel':
        case 'flatchannel':
          this._renderParallelChannel(ctx, d, style);
          break;
        case 'disjointchannel':
          this._renderDisjointChannel(ctx, d);
          break;
        case 'regression':
          this._renderRegressionChannel(ctx, d, style);
          break;
        case 'fibonacci':
          this._renderFibonacci(ctx, d, w, style);
          break;
        case 'fibext':
          this._renderFibExtension(ctx, d, w, style);
          break;
        case 'fibfan':
          this._renderFibFan(ctx, d, w);
          break;
        case 'fibarc':
          this._renderFibArc(ctx, d);
          break;
        case 'fibtz':
          this._renderFibTimezones(ctx, d, h);
          break;
        case 'gannbox':
          this._renderGannBox(ctx, d, style);
          break;
        case 'gannfan':
          this._renderGannFan(ctx, d, w);
          break;
        case 'gannsquare':
          this._renderGannSquare(ctx, d, style);
          break;
        case 'pricerange':
        case 'dtpricerange':
          this._renderPriceRange(ctx, d, w, style);
          break;
        case 'daterange':
          this._renderDateRange(ctx, d, style);
          break;
        case 'trendangle':
          this._renderTrendAngle(ctx, d, style);
          break;
        case 'longposition':
          this._renderPositionTool(ctx, d, style, true);
          break;
        case 'shortposition':
          this._renderPositionTool(ctx, d, style, false);
          break;
        case 'cycliclines':
        case 'timecycles':
          this._renderCyclicLines(ctx, d, h);
          break;
        case 'text':
        case 'richtext':
        case 'note':
        case 'callout':
          this._renderText(ctx, d, style);
          break;
        case 'icon':
        case 'emoji':
          this._renderIcon(ctx, d);
          break;
        case 'pitchfork':
        case 'schiff':
        case 'modschiff':
          this._renderPitchfork(ctx, d, w, h);
          break;
        case 'elliott':
        case 'abcd':
          this._renderWavePath(ctx, d);
          break;
      }

      ctx.restore();
    },

    _renderLineSegment(ctx, d, w, h) {
      if (d.points.length < 2) return;
      const [p1, p2] = d.points;
      if (p1.x === null || p2.x === null) return;
      
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);

      if (d.tool === 'ray') {
        const dx = p2.x - p1.x, dy = p2.y - p1.y;
        ctx.lineTo(p1.x + dx * 100, p1.y + dy * 100);
      } else if (d.tool === 'hray') {
        ctx.lineTo(w, p1.y);
      } else if (d.tool === 'vray') {
        ctx.lineTo(p1.x, h);
      } else {
        ctx.lineTo(p2.x, p2.y);
      }
      ctx.stroke();

      if (d.tool === 'arrow') {
        this._drawArrowhead(ctx, p1.x, p1.y, p2.x, p2.y);
      }
    },

    _drawArrowhead(ctx, x1, y1, x2, y2) {
      const angle = Math.atan2(y2 - y1, x2 - x1);
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - 12 * Math.cos(angle - Math.PI / 6), y2 - 12 * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(x2 - 12 * Math.cos(angle + Math.PI / 6), y2 - 12 * Math.sin(angle + Math.PI / 6));
      ctx.closePath();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
    },

    _renderExtendedLine(ctx, d, w, h) {
      const pts = d._getInfinitePoints(w, h);
      if (!pts) return;
      ctx.beginPath();
      ctx.moveTo(pts.x1, pts.y1);
      ctx.lineTo(pts.x2, pts.y2);
      ctx.stroke();
    },

    _renderHLine(ctx, d, w, h) {
      if (!d.points.length || d.points[0].y === null) return;
      const y = d.points[0].y;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();

      if (d.style.labelVisible && d.points[0].price != null) {
        ctx.fillStyle = d.style.textColor;
        ctx.font = `${d.style.fontSize}px 'Outfit', sans-serif`;
        ctx.fillText(d.points[0].price.toFixed(2), w - 60, y - 4);
      }
    },

    _renderVLine(ctx, d, w, h) {
      if (!d.points.length || d.points[0].x === null) return;
      const x = d.points[0].x;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    },

    _renderCrossLine(ctx, d, w, h) {
      if (!d.points.length || d.points[0].x === null) return;
      const { x, y } = d.points[0];
      ctx.beginPath();
      ctx.moveTo(0, y); ctx.lineTo(w, y);
      ctx.moveTo(x, 0); ctx.lineTo(x, h);
      ctx.stroke();
    },

    _renderRect(ctx, d, style) {
      if (d.points.length < 2) return;
      const [p1, p2] = d.points;
      if (p1.x === null || p2.x === null) return;
      const x = Math.min(p1.x, p2.x), y = Math.min(p1.y, p2.y);
      const rw = Math.abs(p2.x - p1.x), rh = Math.abs(p2.y - p1.y);
      
      ctx.fillStyle = style.fillColor;
      ctx.fillRect(x, y, rw, rh);
      ctx.strokeRect(x, y, rw, rh);
    },

    _renderRoundRect(ctx, d, style) {
      if (d.points.length < 2) return;
      const [p1, p2] = d.points;
      if (p1.x === null || p2.x === null) return;
      const x = Math.min(p1.x, p2.x), y = Math.min(p1.y, p2.y);
      const rw = Math.abs(p2.x - p1.x), rh = Math.abs(p2.y - p1.y);
      const r = Math.min(10, rw / 2, rh / 2);
      
      ctx.beginPath();
      ctx.roundRect(x, y, rw, rh, r);
      ctx.fillStyle = style.fillColor;
      ctx.fill();
      ctx.stroke();
    },

    _renderPolygon(ctx, d, style) {
      if (d.points.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(d.points[0].x, d.points[0].y);
      for (let i = 1; i < d.points.length; i++) {
        ctx.lineTo(d.points[i].x, d.points[i].y);
      }
      if (d.complete) ctx.closePath();
      ctx.fillStyle = style.fillColor;
      ctx.fill();
      ctx.stroke();
    },

    _renderCurve(ctx, d) {
      if (d.points.length < 3) return;
      ctx.beginPath();
      ctx.moveTo(d.points[0].x, d.points[0].y);
      ctx.quadraticCurveTo(d.points[1].x, d.points[1].y, d.points[2].x, d.points[2].y);
      ctx.stroke();
    },

    _renderArc(ctx, d) {
      if (d.points.length < 3) return;
      ctx.beginPath();
      ctx.moveTo(d.points[0].x, d.points[0].y);
      ctx.quadraticCurveTo(d.points[2].x, d.points[2].y, d.points[1].x, d.points[1].y);
      ctx.stroke();
    },

    _renderCircle(ctx, d, style) {
      if (d.points.length < 2) return;
      const [c, rPt] = d.points;
      const r = dist(c.x, c.y, rPt.x, rPt.y);
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fillStyle = style.fillColor;
      ctx.fill();
      ctx.stroke();
    },

    _renderEllipse(ctx, d, style) {
      if (d.points.length < 2) return;
      const [c, size] = d.points;
      const rx = Math.abs(size.x - c.x);
      const ry = Math.abs(size.y - c.y);
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, rx, ry, 0, 0, Math.PI * 2);
      ctx.fillStyle = style.fillColor;
      ctx.fill();
      ctx.stroke();
    },

    _renderParallelChannel(ctx, d, style) {
      if (d.points.length < 2) return;
      const [p1, p2] = d.points;
      const p3 = d.points[2] || { x: p1.x, y: p1.y + 60 };
      
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const p4 = { x: p3.x + dx, y: p3.y + dy };

      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(p3.x, p3.y); ctx.lineTo(p4.x, p4.y); ctx.stroke();

      ctx.fillStyle = style.fillColor;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.lineTo(p4.x, p4.y);
      ctx.lineTo(p3.x, p3.y);
      ctx.closePath();
      ctx.fill();
    },

    _renderDisjointChannel(ctx, d) {
      if (d.points.length < 4) return;
      ctx.beginPath();
      ctx.moveTo(d.points[0].x, d.points[0].y);
      ctx.lineTo(d.points[1].x, d.points[1].y);
      ctx.moveTo(d.points[2].x, d.points[2].y);
      ctx.lineTo(d.points[3].x, d.points[3].y);
      ctx.stroke();
    },

    _renderRegressionChannel(ctx, d, style) {
      if (d.points.length < 2) return;
      const [p1, p2] = d.points;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();

      ctx.fillStyle = style.fillColor;
      ctx.fillRect(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y) - 20, Math.abs(p2.x - p1.x), 40);
      ctx.strokeRect(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y) - 20, Math.abs(p2.x - p1.x), 40);
    },

    _renderFibonacci(ctx, d, w, style) {
      if (d.points.length < 2) return;
      const [p1, p2] = d.points;
      const levels = d.levels;
      const colors = ['#ef4444','#f97316','#eab308','#1ab76d','#38bdf8','#8b5cf6','#ec4899','#64748b'];

      levels.forEach((lvl, i) => {
        const y = p1.y + (p2.y - p1.y) * lvl;
        ctx.strokeStyle = colors[i % colors.length];
        ctx.fillStyle = colors[i % colors.length];
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();

        if (style.labelVisible && p1.price !== null) {
          const val = p1.price + (p2.price - p1.price) * lvl;
          ctx.font = `bold 10px sans-serif`;
          ctx.fillText(`Fib ${lvl} (${val.toFixed(2)})`, 10, y - 4);
        }
      });
    },

    _renderFibExtension(ctx, d, w, style) {
      if (d.points.length < 3) return;
      const [p1, p2, p3] = d.points;
      const diff = p2.y - p1.y;
      const priceDiff = p2.price - p1.price;
      
      d.levels.forEach((lvl, i) => {
        const y = p3.y + diff * lvl;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();

        if (style.labelVisible && p3.price !== null) {
          const val = p3.price + priceDiff * lvl;
          ctx.font = `10px sans-serif`;
          ctx.fillText(`Ext ${lvl} (${val.toFixed(2)})`, 10, y - 4);
        }
      });
    },

    _renderFibFan(ctx, d, w) {
      if (d.points.length < 2) return;
      const [p1, p2] = d.points;
      const levels = [0.382, 0.5, 0.618];
      levels.forEach(lvl => {
        const targetY = p1.y + (p2.y - p1.y) * lvl;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(w, targetY + (targetY - p1.y) * 5);
        ctx.stroke();
      });
    },

    _renderFibArc(ctx, d) {
      if (d.points.length < 2) return;
      const [p1, p2] = d.points;
      const r = dist(p1.x, p1.y, p2.x, p2.y);
      const levels = [0.382, 0.5, 0.618, 1.0];
      levels.forEach(lvl => {
        ctx.beginPath();
        ctx.arc(p1.x, p1.y, r * lvl, 0, Math.PI, false);
        ctx.stroke();
      });
    },

    _renderFibTimezones(ctx, d, h) {
      if (d.points.length < 2) return;
      const [p1, p2] = d.points;
      const base = p2.x - p1.x;
      const zones = [1, 2, 3, 5, 8, 13, 21, 34];
      zones.forEach(z => {
        const x = p1.x + base * z;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      });
    },

    _renderGannBox(ctx, d, style) {
      if (d.points.length < 2) return;
      const [p1, p2] = d.points;
      ctx.fillStyle = style.fillColor;
      ctx.fillRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
      ctx.strokeRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
      
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
      ctx.moveTo(p1.x, p2.y); ctx.lineTo(p2.x, p1.y);
      ctx.stroke();
    },

    _renderGannFan(ctx, d, w) {
      if (d.points.length < 2) return;
      const [p1, p2] = d.points;
      const angles = [1/8, 1/4, 1/3, 1/2, 1, 2, 3, 4, 8];
      const dx = p2.x - p1.x, dy = p2.y - p1.y;
      angles.forEach(a => {
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(w, p1.y + dy * a * 10);
        ctx.stroke();
      });
    },

    _renderGannSquare(ctx, d, style) {
      if (d.points.length < 2) return;
      const [p1, p2] = d.points;
      const size = Math.max(Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
      const x2 = p1.x + (p2.x > p1.x ? size : -size);
      const y2 = p1.y + (p2.y > p1.y ? size : -size);
      
      ctx.strokeRect(p1.x, p1.y, x2 - p1.x, y2 - p1.y);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y); ctx.lineTo(x2, y2);
      ctx.stroke();
    },

    _renderPriceRange(ctx, d, w, style) {
      if (d.points.length < 2) return;
      const [p1, p2] = d.points;
      const x1 = Math.min(p1.x, p2.x), x2 = Math.max(p1.x, p2.x);
      const y1 = Math.min(p1.y, p2.y), y2 = Math.max(p1.y, p2.y);
      
      ctx.fillStyle = style.fillColor;
      ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

      if (d.points[0].price !== null && d.points[1].price !== null) {
        const diff = d.points[1].price - d.points[0].price;
        const pct = (diff / d.points[0].price) * 100;
        const text = `${diff.toFixed(2)} (${pct.toFixed(2)}%)`;
        ctx.fillStyle = style.textColor;
        ctx.font = `bold 10px sans-serif`;
        ctx.fillText(text, (x1 + x2)/2 - 35, (y1 + y2)/2 + 4);
      }
    },

    _renderDateRange(ctx, d, style) {
      if (d.points.length < 2) return;
      const [p1, p2] = d.points;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p1.y);
      ctx.stroke();

      if (p1.timestamp && p2.timestamp) {
        const bars = Math.round(Math.abs(p2.x - p1.x) / 10);
        ctx.fillStyle = style.textColor;
        ctx.font = `10px sans-serif`;
        ctx.fillText(`${bars} bars`, (p1.x + p2.x)/2 - 15, p1.y - 6);
      }
    },

    _renderTrendAngle(ctx, d, style) {
      if (d.points.length < 2) return;
      const [p1, p2] = d.points;
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
      
      const angleRad = getTrendAngle(p1.x, p1.y, p2.x, p2.y);
      const angleDeg = (angleRad * 180 / Math.PI).toFixed(1);
      
      ctx.fillStyle = style.textColor;
      ctx.font = `bold 10px sans-serif`;
      ctx.fillText(`${angleDeg}°`, p2.x + 10, p2.y);
    },

    _renderPositionTool(ctx, d, style, isLong) {
      if (d.points.length < 3) return;
      const [entry, target, stop] = d.points;
      const width = 120;
      
      ctx.fillStyle = isLong ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)';
      ctx.fillRect(entry.x, Math.min(entry.y, target.y), width, Math.abs(entry.y - target.y));

      ctx.fillStyle = isLong ? 'rgba(239, 68, 68, 0.2)' : 'rgba(34, 197, 94, 0.2)';
      ctx.fillRect(entry.x, Math.min(entry.y, stop.y), width, Math.abs(entry.y - stop.y));

      ctx.strokeStyle = style.color;
      ctx.strokeRect(entry.x, Math.min(target.y, stop.y), width, Math.abs(target.y - stop.y));
    },

    _renderCyclicLines(ctx, d, h) {
      if (d.points.length < 2) return;
      const [p1, p2] = d.points;
      const step = Math.abs(p2.x - p1.x);
      if (step < 5) return;
      for (let x = p1.x; x < 2000; x += step) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
    },

    _renderText(ctx, d, style) {
      if (!d.points.length) return;
      const pt = d.points[0];
      ctx.fillStyle = style.textColor;
      ctx.font = `${style.fontSize}px sans-serif`;
      ctx.fillText(d.label || 'Text', pt.x, pt.y);
    },

    _renderIcon(ctx, d) {
      if (!d.points.length) return;
      const pt = d.points[0];
      ctx.fillStyle = d.style.color;
      ctx.font = `20px Outfit`;
      ctx.fillText(d.label || '📍', pt.x - 10, pt.y + 6);
    },

    _renderPitchfork(ctx, d, w, h) {
      if (d.points.length < 3) return;
      const [p0, p1, p2] = d.points;
      let startX = p0.x;
      let startY = p0.y;
      
      if (d.tool === 'schiff') {
        startY = (p0.y + p1.y) / 2;
      } else if (d.tool === 'modschiff') {
        startX = p0.x + (p1.x - p0.x) / 2;
        startY = p0.y + (p1.y - p0.y) / 2;
      }

      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      
      ctx.beginPath(); ctx.moveTo(startX, startY); ctx.lineTo(midX, midY); ctx.stroke();
      
      const dx = midX - startX, dy = midY - startY;
      ctx.beginPath(); ctx.moveTo(midX, midY); ctx.lineTo(midX + dx * 5, midY + dy * 5); ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y); ctx.lineTo(p1.x + dx * 5, p1.y + dy * 5);
      ctx.moveTo(p2.x, p2.y); ctx.lineTo(p2.x + dx * 5, p2.y + dy * 5);
      ctx.stroke();
    },

    _renderWavePath(ctx, d) {
      if (d.points.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(d.points[0].x, d.points[0].y);
      for (let i = 1; i < d.points.length; i++) {
        ctx.lineTo(d.points[i].x, d.points[i].y);
      }
      ctx.stroke();
      
      ctx.fillStyle = d.style.textColor;
      ctx.font = `bold 10px sans-serif`;
      d.points.forEach((p, i) => {
        ctx.fillText(`(${i})`, p.x - 8, p.y - 8);
      });
    },

    _drawPreview(ctx, drawing, cursor, w, h) {
      if (!drawing.points.length) return;
      const last = drawing.points[drawing.points.length - 1];
      if (last.x === null) return;
      
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = drawing.style.color;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(cursor.x, cursor.y);
      ctx.stroke();
      ctx.restore();
    },

    _drawHandles(ctx, drawing) {
      const bb = getBoundingBox(drawing);
      if (bb.w <= 0 && bb.h <= 0) return;

      ctx.save();
      
      // 1. Draw dashed selection box
      ctx.strokeStyle = 'rgba(26, 183, 109, 0.45)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(bb.minX - 2, bb.minY - 2, bb.w + 4, bb.h + 4);
      
      // 2. Draw square corners (Resize handles)
      const handles = getDrawingHandles(drawing);
      
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = drawing.style.color || '#1ab76d';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]); // solid line

      const size = 7; // square size
      handles.forEach(h => {
        if (h.x !== null && h.y !== null && !isNaN(h.x) && !isNaN(h.y)) {
          ctx.beginPath();
          ctx.rect(h.x - size/2, h.y - size/2, size, size);
          ctx.fill();
          ctx.stroke();
        }
      });

      // 3. Draw circle in center (Move handle)
      ctx.beginPath();
      ctx.arc(bb.cx, bb.cy, 9, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#1ab76d';
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();

      // Inner move indicator dot
      ctx.beginPath();
      ctx.arc(bb.cx, bb.cy, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#1ab76d';
      ctx.fill();

      ctx.restore();
    },

    resize() {
      this._resize();
      this.markDirty();
    },

    destroy() {
      if (this._rafId) cancelAnimationFrame(this._rafId);
    }
  };

  // ============================================================
  // GESTURE & INTERACTION MANAGER
  // ============================================================
  const GestureManager = {
    _manager: null,
    _dragging: false,
    _dragHandleIndex: -1,
    _dragDrawing: null,
    _dragStart: null,
    _lastPos: null,

    init(manager) {
      this._manager = manager;
      this._attachEvents();
    },

    _getPos(e) {
      const canvas = document.getElementById('gxm-drawing-canvas');
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      const src = e.touches ? e.touches[0] : e;
      return { x: src.clientX - rect.left, y: src.clientY - rect.top };
    },

    _attachEvents() {
      const container = document.getElementById('gainex-chart');
      if (!container) return;

      container.addEventListener('mousedown',  (e) => this._onDown(e), true);
      container.addEventListener('mousemove',  (e) => this._onMove(e), true);
      container.addEventListener('mouseup',    (e) => this._onUp(e),   true);
      container.addEventListener('dblclick',   (e) => this._onDblClick(e), true);
      container.addEventListener('touchstart', (e) => this._onDown(e), { capture: true, passive: false });
      container.addEventListener('touchmove',  (e) => this._onMove(e), { capture: true, passive: false });
      container.addEventListener('touchend',   (e) => this._onUp(e),   { capture: true, passive: false });
    },

    _onDown(e) {
      if (e.target && (e.target.id === 'gxm-quick-delete-btn' || e.target.closest('#gxm-quick-delete-btn'))) {
        return;
      }

      const pos = this._getPos(e);
      const mgr = this._manager;

      if (mgr.activeTool) {
        e.stopPropagation();
        e.preventDefault();
        mgr._addAnchor(pos.x, pos.y);
        DrawingRenderer.markDirty();
        return;
      }

      const selected = mgr.selectedDrawing;
      if (selected) {
        const hi = HitTestEngine.findHandle(selected, pos.x, pos.y, 22, 24); // generous click target
        if (hi >= 0) {
          e.stopPropagation();
          e.preventDefault();
          this._dragging = true;
          this._dragHandleIndex = hi;
          this._dragDrawing = selected;
          mgr.draggedDrawing = selected;
          this._dragStart = pos;
          this._lastPos = pos;
          
          if (hi === 99) {
            // Center handle means move! Set index to -1 so move By executes.
            this._dragHandleIndex = -1;
            this._setCursor('grabbing');
          } else {
            // Anchor point index means resize! Store copy of start coordinates
            this._dragStartPoints = selected.points.map(p => ({ x: p.x, y: p.y }));
            this._setCursor(getResizeCursor(selected, hi));
          }
          return;
        }

        // If no handle hit but click is inside the bounding box → treat as move drag
        const bb = getBoundingBox(selected);
        if (pos.x >= bb.minX && pos.x <= bb.maxX && pos.y >= bb.minY && pos.y <= bb.maxY) {
          e.stopPropagation();
          e.preventDefault();
          this._dragging = true;
          this._dragHandleIndex = -1;
          this._dragDrawing = selected;
          mgr.draggedDrawing = selected;
          this._dragStart = pos;
          this._lastPos = pos;
          this._setCursor('grabbing');
          return;
        }
      }

      const hit = HitTestEngine.findHit(mgr.drawings, pos.x, pos.y);
      if (hit) {
        e.stopPropagation();
        e.preventDefault();
        mgr.select(hit);
        this._dragging = true;
        this._dragHandleIndex = -1;
        this._dragDrawing = hit;
        mgr.draggedDrawing = hit; // Mark as currently dragging
        this._dragStart = pos;
        this._lastPos = pos;
        this._setCursor('grabbing');
      } else {
        if (selected) {
          mgr.deselect();
          DrawingRenderer.markDirty();
        }
        this._dragging = false;
        mgr.draggedDrawing = null;
      }
    },

    _onMove(e) {
      const pos = this._getPos(e);
      this._manager._cursor = pos;

      if (this._dragging && this._dragDrawing) {
        e.stopPropagation();
        e.preventDefault();
        const dx = pos.x - this._lastPos.x;
        const dy = pos.y - this._lastPos.y;

        if (this._dragHandleIndex >= 0) {
          // Direct drag resize of selected point/handle index!
          const pts = this._dragDrawing.points;
          let finalX = pos.x;
          let finalY = pos.y;
          
          if (DrawingEngine.magnetMode && window.chart && chart.candles && chart.candles.length) {
            const snapped = SnapEngine.findNearestOHLC(pos.x, pos.y);
            if (snapped) {
              finalX = snapped.x;
              finalY = snapped.y;
            }
          }
          
          if (this._dragDrawing.tool === 'channel' || this._dragDrawing.tool === 'flatchannel') {
            if (this._dragHandleIndex === 0) { // top-left
              pts[0].x = finalX; pts[0].y = finalY;
            } else if (this._dragHandleIndex === 1) { // top-right
              pts[1].x = finalX; pts[1].y = finalY;
            } else if (this._dragHandleIndex === 2) { // bottom-left
              pts[2].x = finalX; pts[2].y = finalY;
            } else if (this._dragHandleIndex === 3) { // bottom-right
              // Dragging p4: shift p2 and p3 to follow the drag
              const p1 = pts[0], p2 = pts[1], p3 = pts[2];
              const curP4x = p3.x + p2.x - p1.x;
              const curP4y = p3.y + p2.y - p1.y;
              const dx = finalX - curP4x;
              const dy = finalY - curP4y;
              p2.x += dx; p2.y += dy;
              p3.x += dx; p3.y += dy;
            }
            
            // Sync all point time/prices
            pts.forEach(pt => {
              pt.timestamp = CoordinateConverter.xToTime(pt.x);
              pt.price = CoordinateConverter.yToPrice(pt.y);
            });
          } else if (this._dragDrawing.tool === 'circle') {
            // Corner handles 0=TL, 1=TR, 2=BL, 3=BR. Opposite corner stays fixed using start points.
            const startDrawing = { tool: 'circle', points: this._dragStartPoints };
            const bb = getBoundingBox(startDrawing);
            const oppositeX = (this._dragHandleIndex === 0 || this._dragHandleIndex === 2) ? bb.maxX : bb.minX;
            const oppositeY = (this._dragHandleIndex === 0 || this._dragHandleIndex === 1) ? bb.maxY : bb.minY;
            // New center is midpoint of dragged corner and fixed opposite corner
            const newCx = (finalX + oppositeX) / 2;
            const newCy = (finalY + oppositeY) / 2;
            // Radius is half the diagonal, but keep circle perfectly round — use min to preserve shape
            const halfW = Math.abs(finalX - oppositeX) / 2;
            const halfH = Math.abs(finalY - oppositeY) / 2;
            const newR = Math.max(halfW, halfH);
            pts[0].x = newCx; pts[0].y = newCy;
            pts[1].x = newCx + newR; pts[1].y = newCy;
            pts[0].timestamp = CoordinateConverter.xToTime(newCx);
            pts[0].price = CoordinateConverter.yToPrice(newCy);
            pts[1].timestamp = CoordinateConverter.xToTime(newCx + newR);
            pts[1].price = CoordinateConverter.yToPrice(newCy);
          } else if (this._dragDrawing.tool === 'ellipse') {
            // Corner handles 0=TL, 1=TR, 2=BL, 3=BR. Opposite corner stays fixed using start points.
            const startDrawing = { tool: 'ellipse', points: this._dragStartPoints };
            const bb = getBoundingBox(startDrawing);
            const oppositeX = (this._dragHandleIndex === 0 || this._dragHandleIndex === 2) ? bb.maxX : bb.minX;
            const oppositeY = (this._dragHandleIndex === 0 || this._dragHandleIndex === 1) ? bb.maxY : bb.minY;
            const newCx = (finalX + oppositeX) / 2;
            const newCy = (finalY + oppositeY) / 2;
            const newRx = Math.abs(finalX - oppositeX) / 2;
            const newRy = Math.abs(finalY - oppositeY) / 2;
            pts[0].x = newCx; pts[0].y = newCy;
            pts[1].x = newCx + newRx; pts[1].y = newCy + newRy;
            pts[0].timestamp = CoordinateConverter.xToTime(newCx);
            pts[0].price = CoordinateConverter.yToPrice(newCy);
            pts[1].timestamp = CoordinateConverter.xToTime(newCx + newRx);
            pts[1].price = CoordinateConverter.yToPrice(newCy + newRy);
          } else if (['rectangle','roundrect','gannbox','pricerange','daterange','dtpricerange','regression'].includes(this._dragDrawing.tool)) {
            // Box-tools: 2 raw points (p1=one corner, p2=opposite corner).
            // Handles are 0=TL,1=TR,2=BL,3=BR mapped from bounding box.
            // We lock the OPPOSITE bounding-box corner using start points.
            const startDrawing = { tool: this._dragDrawing.tool, points: this._dragStartPoints };
            const bb = getBoundingBox(startDrawing);
            const oppX = (this._dragHandleIndex === 0 || this._dragHandleIndex === 2) ? bb.maxX : bb.minX;
            const oppY = (this._dragHandleIndex === 0 || this._dragHandleIndex === 1) ? bb.maxY : bb.minY;
            // Set p1 to the dragged corner, p2 to the locked opposite corner
            pts[0].x = finalX; pts[0].y = finalY;
            pts[1].x = oppX;   pts[1].y = oppY;
            pts[0].timestamp = CoordinateConverter.xToTime(finalX);
            pts[0].price = CoordinateConverter.yToPrice(finalY);
            pts[1].timestamp = CoordinateConverter.xToTime(oppX);
            pts[1].price = CoordinateConverter.yToPrice(oppY);
          } else if (this._dragDrawing.tool === 'gannsquare') {
            // GannSquare: 2 raw points, p1=origin, p2=size hint — resize by moving p2 proportionally
            const startDrawing = { tool: 'gannsquare', points: this._dragStartPoints };
            const bb = getBoundingBox(startDrawing);
            const oppX = (this._dragHandleIndex === 0 || this._dragHandleIndex === 2) ? bb.maxX : bb.minX;
            const oppY = (this._dragHandleIndex === 0 || this._dragHandleIndex === 1) ? bb.maxY : bb.minY;
            pts[0].x = finalX; pts[0].y = finalY;
            pts[1].x = oppX;   pts[1].y = oppY;
            pts[0].timestamp = CoordinateConverter.xToTime(finalX);
            pts[0].price = CoordinateConverter.yToPrice(finalY);
            pts[1].timestamp = CoordinateConverter.xToTime(oppX);
            pts[1].price = CoordinateConverter.yToPrice(oppY);
          } else {
            // General point update (for trendlines, fibonacci, triangle, etc.)
            const pt = pts[this._dragHandleIndex];
            if (pt) {
              pt.x = finalX;
              pt.y = finalY;
              pt.timestamp = CoordinateConverter.xToTime(finalX);
              pt.price = CoordinateConverter.yToPrice(finalY);
            }
          }
        } else {
          // Standard Move
          this._dragDrawing.moveBy(dx, dy);
        }
        this._lastPos = pos;
        DrawingRenderer.markDirty();
        return;
      }

      if (this._manager.activeTool) {
        e.stopPropagation();
        e.preventDefault();
      }

      if (!this._manager.activeTool) {
        // If there's a selected drawing, check handles hover state first
        const selected = this._manager.selectedDrawing;
        if (selected) {
          const hi = HitTestEngine.findHandle(selected, pos.x, pos.y, 22, 24);
          if (hi >= 0) {
            e.stopPropagation();
            if (hi === 99) {
              this._setCursor('move');
            } else {
              this._setCursor(getResizeCursor(selected, hi));
            }
            DrawingRenderer.markDirty();
            return;
          }

          // Show grab cursor when hovering anywhere inside the bounding box
          const bb = getBoundingBox(selected);
          if (pos.x >= bb.minX && pos.x <= bb.maxX && pos.y >= bb.minY && pos.y <= bb.maxY) {
            e.stopPropagation();
            this._setCursor('grab');
            DrawingRenderer.markDirty();
            return;
          }
        }

        const hit = HitTestEngine.findHit(this._manager.drawings, pos.x, pos.y);
        if (hit) {
          e.stopPropagation();
          this._setCursor(hit.locked ? 'not-allowed' : (hit.selected ? 'grab' : 'pointer'));
        } else {
          this._setCursor('default');
        }
      }

      DrawingRenderer.markDirty();
    },

    _onUp(e) {
      const mgr = this._manager;
      if (this._dragging && this._dragDrawing) {
        e.stopPropagation();
        e.preventDefault();

        // Convert the final coordinates back to time and price on release
        for (const pt of this._dragDrawing.points) {
          let finalX = pt.x;
          let finalY = pt.y;

          if (DrawingEngine.magnetMode) {
            const snapped = SnapEngine.findNearestOHLC(pt.x, pt.y);
            if (snapped) {
              finalX = snapped.x;
              finalY = snapped.y;
              pt.x = finalX;
              pt.y = finalY;
            }
          }

          const newTimestamp = CoordinateConverter.xToTime(finalX);
          const newPrice = CoordinateConverter.yToPrice(finalY);
          if (newTimestamp != null) pt.timestamp = newTimestamp;
          if (newPrice != null) pt.price = newPrice;
        }

        DrawingHistory.snapshot(mgr.drawings);
        DrawingStorage.save(mgr.drawings);
      }
      this._dragging = false;
      this._dragHandleIndex = -1;
      this._dragDrawing = null;
      if (mgr) mgr.draggedDrawing = null; // Clear dragged state
      this._setCursor(mgr.activeTool ? 'crosshair' : 'default');
      DrawingRenderer.markDirty();
    },

    _onDblClick(e) {
      const pos = this._getPos(e);
      const hit = HitTestEngine.findHit(this._manager.drawings, pos.x, pos.y);
      if (hit) {
        e.stopPropagation();
        e.preventDefault();
        StylePanelManager.open(hit);
      }
    },

    _setCursor(cursor) {
      const container = document.getElementById('gainex-chart');
      if (container) {
        container.style.setProperty('cursor', cursor, 'important');
        const canvases = container.querySelectorAll('canvas');
        canvases.forEach(c => {
          c.style.setProperty('cursor', cursor, 'important');
        });
      }
    }
  };

  function getCenterPoints(tool, cx, cy) {
    const pts = [];
    const needed = TOOL_ANCHOR_COUNT[tool] || 2;
    
    if (needed === 1) {
      pts.push({ x: cx, y: cy });
    } else if (needed === 2) {
      pts.push({ x: cx - 80, y: cy - 30 });
      pts.push({ x: cx + 80, y: cy + 30 });
    } else if (needed === 3) {
      if (tool === 'channel' || tool === 'flatchannel') {
        pts.push({ x: cx - 80, y: cy - 30 }); // Point 0: p1
        pts.push({ x: cx + 80, y: cy - 30 }); // Point 1: p2
        pts.push({ x: cx - 80, y: cy + 30 }); // Point 2: p3 (bottom-left)
      } else {
        pts.push({ x: cx - 80, y: cy - 30 });
        pts.push({ x: cx + 80, y: cy - 30 });
        pts.push({ x: cx, y: cy + 30 });
      }
    } else if (needed === 4) {
      pts.push({ x: cx - 100, y: cy - 30 });
      pts.push({ x: cx - 30, y: cy + 30 });
      pts.push({ x: cx + 30, y: cy - 30 });
      pts.push({ x: cx + 100, y: cy + 30 });
    } else {
      const count = needed === 99 ? 5 : needed;
      const step = 200 / (count - 1);
      for (let i = 0; i < count; i++) {
        const px = cx - 100 + i * step;
        const py = cy + (i % 2 === 0 ? 30 : -30);
        pts.push({ x: px, y: py });
      }
    }

    return pts.map(pt => {
      const timestamp = CoordinateConverter.xToTime(pt.x);
      const price = CoordinateConverter.yToPrice(pt.y);
      return { timestamp, price, x: pt.x, y: pt.y };
    });
  }

  // ============================================================
  // DRAWING MANAGER — Main Controller
  // ============================================================
  class DrawingManager {
    constructor() {
      this.drawings = [];
      this.current = null;
      this.activeTool = null;
      this.selectedDrawing = null;
      this._cursor = null;
      this._pointerMode = true;
    }

    _addAnchor(x, y) {
      if (!this.activeTool) return;

      if (!this.current) {
        const Cls = TOOL_CLASSES[this.activeTool];
        if (!Cls) return;
        this.current = new Cls();
      }

      const pt = CoordinateConverter.capturePoint(x, y);
      this.current.points.push(pt);

      const needed = TOOL_ANCHOR_COUNT[this.activeTool];

      if (this.current.points.length >= needed) {
        this.current.complete = true;
        this.drawings.push(this.current);
        DrawingHistory.snapshot(this.drawings);
        DrawingStorage.save(this.drawings);
        
        if (needed === 1) {
          this.current = null;
          this.setTool(null);
        } else {
          this.current = null;
        }
      }
    }

    setTool(toolName) {
      if (toolName && toolName !== '__pointer__') {
        const canvas = document.getElementById('gxm-drawing-canvas');
        if (canvas) {
          const rect = canvas.getBoundingClientRect();
          const cx = rect.width / 2;
          const cy = rect.height / 2;

          const Cls = TOOL_CLASSES[toolName];
          if (Cls) {
            let labelText = '';
            if (toolName === 'text' || toolName === 'richtext' || toolName === 'note' || toolName === 'callout') {
              const txt = prompt('Enter text to display:', 'Text');
              if (txt === null) {
                // User cancelled the prompt, abort tool activation
                this.activeTool = null;
                this._pointerMode = true;
                GestureManager._setCursor('default');
                ToolbarManager.setActive('__pointer__');
                return;
              }
              labelText = txt;
            }

            const drawing = new Cls();
            drawing.points = getCenterPoints(toolName, cx, cy);
            drawing.label = labelText;
            drawing.complete = true;
            this.drawings.push(drawing);
            
            DrawingHistory.snapshot(this.drawings);
            DrawingStorage.save(this.drawings);
            
            // Automatically select the drawing
            this.select(drawing);
            DrawingRenderer.markDirty();
          }
        }
        // Force back to pointer tool selection
        this.activeTool = null;
        this._pointerMode = true;
        GestureManager._setCursor('default');
        ToolbarManager.setActive('__pointer__');
        return;
      }

      this.activeTool = toolName;
      this.current = null;
      this.deselect();
      const isPointer = toolName === '__pointer__';
      if (isPointer) {
        this.activeTool = null;
        this._pointerMode = true;
        GestureManager._setCursor('default');
      } else {
        this._pointerMode = false;
        GestureManager._setCursor('default');
      }
      ToolbarManager.setActive(toolName);
      DrawingRenderer.markDirty();
    }

    select(drawing) {
      if (this.selectedDrawing) this.selectedDrawing.selected = false;
      this.selectedDrawing = drawing;
      if (drawing) {
        drawing.selected = true;
      }
      DrawingRenderer.markDirty();
    }

    deselect() {
      if (this.selectedDrawing) this.selectedDrawing.selected = false;
      this.selectedDrawing = null;
      DrawingRenderer.markDirty();
    }

    deleteSelected() {
      if (!this.selectedDrawing) return;
      DrawingHistory.snapshot(this.drawings);
      this.drawings = this.drawings.filter(d => d !== this.selectedDrawing);
      this.selectedDrawing = null;
      DrawingStorage.save(this.drawings);
      DrawingRenderer.markDirty();
    }

    duplicateSelected() {
      if (!this.selectedDrawing) return;
      const Cls = TOOL_CLASSES[this.selectedDrawing.tool];
      if (!Cls) return;
      const copy = new Cls();
      copy.fromJSON(this.selectedDrawing.toJSON());
      copy.id = uid();
      copy.moveBy(15, 15);
      
      // Update timestamps/prices of copy points
      for (const pt of copy.points) {
        const newTimestamp = CoordinateConverter.xToTime(pt.x);
        const newPrice = CoordinateConverter.yToPrice(pt.y);
        if (newTimestamp != null) pt.timestamp = newTimestamp;
        if (newPrice != null) pt.price = newPrice;
      }

      this.drawings.push(copy);
      DrawingHistory.snapshot(this.drawings);
      DrawingStorage.save(this.drawings);
      DrawingRenderer.markDirty();
    }

    toggleLockSelected() {
      if (!this.selectedDrawing) return;
      this.selectedDrawing.locked = !this.selectedDrawing.locked;
      DrawingStorage.save(this.drawings);
      DrawingRenderer.markDirty();
    }

    toggleHideSelected() {
      if (!this.selectedDrawing) return;
      this.selectedDrawing.hidden = !this.selectedDrawing.hidden;
      DrawingStorage.save(this.drawings);
      DrawingRenderer.markDirty();
    }

    bringForward() {
      if (!this.selectedDrawing) return;
      this.selectedDrawing.layer = Math.min(100, this.selectedDrawing.layer + 1);
      DrawingStorage.save(this.drawings);
      DrawingRenderer.markDirty();
    }

    sendBackward() {
      if (!this.selectedDrawing) return;
      this.selectedDrawing.layer = Math.max(-100, this.selectedDrawing.layer - 1);
      DrawingStorage.save(this.drawings);
      DrawingRenderer.markDirty();
    }

    clearAll() {
      DrawingHistory.snapshot(this.drawings);
      this.drawings = [];
      this.current = null;
      this.selectedDrawing = null;
      DrawingStorage.clear();
      DrawingRenderer.markDirty();
    }

    undo() { DrawingHistory.undo(this); }
    redo() { DrawingHistory.redo(this); }
  }

  // ============================================================
  // STYLE PANEL MANAGER
  // ============================================================
  const StylePanelManager = {
    _drawing: null,

    open(drawing) {
      this._drawing = drawing;
      let panel = document.getElementById('gxm-style-panel');
      if (!panel) {
        panel = this._create();
        document.body.appendChild(panel);
      }
      panel.querySelector('#gxm-sp-color').value = drawing.style.color;
      panel.querySelector('#gxm-sp-opacity').value = Math.round(drawing.style.opacity * 100);
      panel.querySelector('#gxm-sp-opacity-lbl').textContent = Math.round(drawing.style.opacity * 100) + '%';
      panel.querySelector('#gxm-sp-width').value = drawing.style.lineWidth;
      panel.querySelector('#gxm-sp-style').value = drawing.style.lineStyle;
      panel.querySelector('#gxm-sp-fill-color').value = drawing.style.fillColor.startsWith('#') ? drawing.style.fillColor : '#1ab76d';
      panel.querySelector('#gxm-sp-shadow').checked = drawing.style.shadow || false;
      panel.querySelector('#gxm-sp-label').checked = drawing.style.labelVisible !== false;
      
      // Populate text label field
      panel.querySelector('#gxm-sp-text-val').value = drawing.label || '';
      
      panel.style.display = 'flex';
    },

    close() {
      const panel = document.getElementById('gxm-style-panel');
      if (panel) panel.style.display = 'none';
      this._drawing = null;
    },

    _create() {
      const panel = document.createElement('div');
      panel.id = 'gxm-style-panel';
      panel.innerHTML = `
        <div class="gxm-sp-header">
          <span>Properties</span>
          <button class="gxm-sp-close" onclick="DrawingEngine._stylePanel.close()">✕</button>
        </div>
        <div class="gxm-sp-row">
          <label>Text Label</label>
          <input type="text" id="gxm-sp-text-val" placeholder="Custom text...">
        </div>
        <div class="gxm-sp-row">
          <label>Color</label>
          <input type="color" id="gxm-sp-color" value="#1ab76d">
        </div>
        <div class="gxm-sp-row">
          <label>Fill</label>
          <input type="color" id="gxm-sp-fill-color" value="#1ab76d">
        </div>
        <div class="gxm-sp-row">
          <label>Opacity <span id="gxm-sp-opacity-lbl">85%</span></label>
          <input type="range" id="gxm-sp-opacity" min="10" max="100" value="85">
        </div>
        <div class="gxm-sp-row">
          <label>Line Width</label>
          <select id="gxm-sp-width">
            <option value="1">1px</option>
            <option value="2" selected>2px</option>
            <option value="3">3px</option>
            <option value="4">4px</option>
          </select>
        </div>
        <div class="gxm-sp-row">
          <label>Line Style</label>
          <select id="gxm-sp-style">
            <option value="solid">Solid</option>
            <option value="dashed">Dashed</option>
            <option value="dotted">Dotted</option>
          </select>
        </div>
        <div class="gxm-sp-row">
          <label>Options</label>
          <div style="display:flex;gap:10px;">
            <label style="font-size:11px;"><input type="checkbox" id="gxm-sp-shadow"> Shadow</label>
            <label style="font-size:11px;"><input type="checkbox" id="gxm-sp-label" checked> Label</label>
          </div>
        </div>
        <div class="gxm-sp-actions">
          <button class="gxm-sp-btn gxm-sp-apply" onclick="DrawingEngine._stylePanel._apply()">Apply</button>
          <button class="gxm-sp-btn gxm-sp-delete" onclick="DrawingEngine.manager.deleteSelected(); DrawingEngine._stylePanel.close()">Delete</button>
        </div>
      `;
      panel.querySelector('#gxm-sp-opacity').addEventListener('input', (e) => {
        panel.querySelector('#gxm-sp-opacity-lbl').textContent = e.target.value + '%';
      });
      return panel;
    },

    _apply() {
      if (!this._drawing) return;
      const panel = document.getElementById('gxm-style-panel');
      if (!panel) return;
      
      // Update label value
      this._drawing.label = panel.querySelector('#gxm-sp-text-val').value;
      
      this._drawing.style.color = panel.querySelector('#gxm-sp-color').value;
      this._drawing.style.textColor = panel.querySelector('#gxm-sp-color').value; // sync textColor as well!
      
      this._drawing.style.fillColor = panel.querySelector('#gxm-sp-fill-color').value + '14'; 
      this._drawing.style.opacity = parseInt(panel.querySelector('#gxm-sp-opacity').value) / 100;
      this._drawing.style.lineWidth = parseInt(panel.querySelector('#gxm-sp-width').value);
      this._drawing.style.lineStyle = panel.querySelector('#gxm-sp-style').value;
      this._drawing.style.shadow = panel.querySelector('#gxm-sp-shadow').checked;
      this._drawing.style.labelVisible = panel.querySelector('#gxm-sp-label').checked;
      
      DrawingHistory.snapshot(DrawingEngine.manager.drawings);
      DrawingStorage.save(DrawingEngine.manager.drawings);
      DrawingRenderer.markDirty();
      this.close();
    }
  };

  // ============================================================
  // TOOLBAR MANAGER
  // ============================================================
  const ToolbarManager = {
    _buttons: {},

    TOOLS: [
      { id: '__pointer__', icon: '↖', label: 'Select' },
      { id: 'trendline',   icon: '↗', label: 'Trend Line' },
      { id: 'ray',         icon: '⬈', label: 'Ray' },
      { id: 'extline',     icon: '↔', label: 'Extended Line' },
      { id: 'hline',       icon: '─', label: 'Horizontal Line' },
      { id: 'hray',        icon: '➔', label: 'Horizontal Ray' },
      { id: 'vline',       icon: '│', label: 'Vertical Line' },
      { id: 'rectangle',   icon: '▭', label: 'Rectangle' },
      { id: 'roundrect',   icon: '▢', label: 'Rounded Rect' },
      { id: 'triangle',    icon: '△', label: 'Triangle' },
      { id: 'polygon',     icon: '⬡', label: 'Polygon' },
      { id: 'circle',      icon: '◯', label: 'Circle' },
      { id: 'ellipse',     icon: '⬭', label: 'Ellipse' },
      { id: 'channel',     icon: '⟺', label: 'Parallel Channel' },
      { id: 'fibonacci',   icon: 'φ', label: 'Fibonacci Retracement' },
      { id: 'fibext',      icon: '🎛', label: 'Fibonacci Extension' },
      { id: 'fibfan',      icon: '扇', label: 'Fibonacci Fan' },
      { id: 'gannbox',     icon: 'Gann', label: 'Gann Box' },
      { id: 'pricerange',  icon: '↕', label: 'Price Range' },
      { id: 'daterange',   icon: '↔', label: 'Date Range' },
      { id: 'trendangle',  icon: '∠', label: 'Trend Angle' },
      { id: 'longposition', icon: '🟢', label: 'Long Position' },
      { id: 'shortposition', icon: '🔴', label: 'Short Position' },
      { id: 'text',        icon: 'T', label: 'Text' },
      { id: 'arrow',       icon: '➚', label: 'Arrow' },
      { id: 'pitchfork',   icon: 'Ψ', label: 'Andrews Pitchfork' }
    ],

    init(manager) {
      this._createToolbar(manager);
    },

    _createToolbar(manager) {
      let tb = document.getElementById('gxm-drawing-toolbar');
      if (tb) tb.remove();

      tb = document.createElement('div');
      tb.id = 'gxm-drawing-toolbar';
      tb.setAttribute('role', 'toolbar');

      const magnetBtn = document.createElement('button');
      magnetBtn.type = 'button';
      magnetBtn.id = 'gxm-draw-magnet';
      magnetBtn.className = 'gxm-tb-btn';
      magnetBtn.title = 'Magnet Mode (Snap to OHLC)';
      magnetBtn.innerHTML = '<span class="gxm-tb-icon">🧲</span>';
      magnetBtn.addEventListener('click', () => {
        DrawingEngine.magnetMode = !DrawingEngine.magnetMode;
        magnetBtn.classList.toggle('gxm-tb-active', DrawingEngine.magnetMode);
      });
      tb.appendChild(magnetBtn);

      const div0 = document.createElement('div');
      div0.className = 'gxm-tb-divider';
      tb.appendChild(div0);

      // Create Color Basket button
      const colorBtn = document.createElement('button');
      colorBtn.type = 'button';
      colorBtn.id = 'gxm-draw-colorbucket';
      colorBtn.className = 'gxm-tb-btn';
      colorBtn.title = 'Color Basket (Quick Color)';
      colorBtn.innerHTML = '<span class="gxm-tb-icon">🎨</span>';
      tb.appendChild(colorBtn);

      // Create the popup list container
      const colorPopup = document.createElement('div');
      colorPopup.id = 'gxm-tb-colorpopup';
      colorPopup.style.cssText = `
        display: none;
        position: absolute;
        top: 38px;
        z-index: 2000;
        background: rgba(10, 14, 26, 0.98);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 8px;
        padding: 8px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.6);
        grid-template-columns: repeat(4, 1fr);
        gap: 6px;
      `;
      if (document.body.classList.contains('light-theme')) {
        colorPopup.style.background = '#ffffff';
        colorPopup.style.borderColor = 'rgba(0,0,0,0.1)';
      }
      
      const colors = [
        '#1ab76d', // Green
        '#ef4444', // Red
        '#3b82f6', // Blue
        '#f59e0b', // Yellow
        '#8b5cf6', // Purple
        '#f97316', // Orange
        '#ffffff', // White
        '#64748b'  // Grey
      ];

      colors.forEach(col => {
        const item = document.createElement('div');
        item.style.cssText = `
          width: 20px;
          height: 20px;
          border-radius: 50%;
          background: ${col};
          cursor: pointer;
          border: 1px solid rgba(255,255,255,0.2);
          transition: transform 0.15s;
        `;
        item.addEventListener('mouseenter', () => { item.style.transform = 'scale(1.15)'; });
        item.addEventListener('mouseleave', () => { item.style.transform = 'scale(1)'; });
        item.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const selected = manager.selectedDrawing;
          if (selected) {
            selected.style.color = col;
            selected.style.textColor = col;
            selected.style.fillColor = col + '14'; // 8% opacity fill
            DrawingHistory.snapshot(manager.drawings);
            DrawingStorage.save(manager.drawings);
            DrawingRenderer.markDirty();
          } else {
            alert('Please select a drawing element on the chart first!');
          }
          colorPopup.style.display = 'none';
        });
        colorPopup.appendChild(item);
      });

      // Show/hide logic
      colorBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const rect = colorBtn.getBoundingClientRect();
        const tbRect = tb.getBoundingClientRect();
        // Position popup right below the color basket button relative to the toolbar parent
        colorPopup.style.left = (rect.left - tbRect.left) + 'px';
        colorPopup.style.display = colorPopup.style.display === 'grid' ? 'none' : 'grid';
      });

      document.addEventListener('click', () => {
        colorPopup.style.display = 'none';
      });

      tb.appendChild(colorPopup);

      // Create Divider after Color Basket
      const divColor = document.createElement('div');
      divColor.className = 'gxm-tb-divider';
      tb.appendChild(divColor);

      for (const tool of this.TOOLS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = `gxm-tb-${tool.id}`;
        btn.className = 'gxm-tb-btn';
        btn.title = tool.label;
        btn.innerHTML = `<span class="gxm-tb-icon">${tool.icon}</span>`;
        btn.addEventListener('click', () => {
          const isActive = manager.activeTool === tool.id;
          manager.setTool(isActive ? null : tool.id);
        });
        this._buttons[tool.id] = btn;
        tb.appendChild(btn);
      }

      const div1 = document.createElement('div');
      div1.className = 'gxm-tb-divider';
      tb.appendChild(div1);

      const undoBtn = document.createElement('button');
      undoBtn.type = 'button'; undoBtn.id = 'gxm-draw-undo';
      undoBtn.className = 'gxm-tb-btn'; undoBtn.title = 'Undo (Ctrl+Z)';
      undoBtn.innerHTML = '<span class="gxm-tb-icon">↩</span>';
      undoBtn.disabled = true;
      undoBtn.addEventListener('click', () => manager.undo());
      tb.appendChild(undoBtn);

      const redoBtn = document.createElement('button');
      redoBtn.type = 'button'; redoBtn.id = 'gxm-draw-redo';
      redoBtn.className = 'gxm-tb-btn'; redoBtn.title = 'Redo (Ctrl+Y)';
      redoBtn.innerHTML = '<span class="gxm-tb-icon">↪</span>';
      redoBtn.disabled = true;
      redoBtn.addEventListener('click', () => manager.redo());
      tb.appendChild(redoBtn);

      const div2 = document.createElement('div');
      div2.className = 'gxm-tb-divider';
      tb.appendChild(div2);

      const upBtn = document.createElement('button');
      upBtn.type = 'button'; upBtn.className = 'gxm-tb-btn'; upBtn.title = 'Bring Forward';
      upBtn.innerHTML = '<span class="gxm-tb-icon">▲</span>';
      upBtn.addEventListener('click', () => manager.bringForward());
      tb.appendChild(upBtn);

      const downBtn = document.createElement('button');
      downBtn.type = 'button'; downBtn.className = 'gxm-tb-btn'; downBtn.title = 'Send Backward';
      downBtn.innerHTML = '<span class="gxm-tb-icon">▼</span>';
      downBtn.addEventListener('click', () => manager.sendBackward());
      tb.appendChild(downBtn);

      const dupBtn = document.createElement('button');
      dupBtn.type = 'button'; dupBtn.className = 'gxm-tb-btn'; dupBtn.title = 'Duplicate Selected';
      dupBtn.innerHTML = '<span class="gxm-tb-icon">⧉</span>';
      dupBtn.addEventListener('click', () => manager.duplicateSelected());
      tb.appendChild(dupBtn);

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button'; deleteBtn.className = 'gxm-tb-btn gxm-tb-danger'; deleteBtn.title = 'Delete Selected (Del)';
      deleteBtn.innerHTML = '<span class="gxm-tb-icon">🗑</span>';
      deleteBtn.addEventListener('click', () => manager.deleteSelected());
      tb.appendChild(deleteBtn);

      const div3 = document.createElement('div');
      div3.className = 'gxm-tb-divider';
      tb.appendChild(div3);

      const clearBtn = document.createElement('button');
      clearBtn.type = 'button'; clearBtn.id = 'gxm-draw-clear-all'; clearBtn.className = 'gxm-tb-btn gxm-tb-danger gxm-tb-remove-all'; clearBtn.title = 'Remove All Drawings';
      clearBtn.innerHTML = '<span class="gxm-tb-icon">🗑</span><span class="gxm-tb-remove-all-label">Remove All</span>';
      clearBtn.addEventListener('click', () => manager.clearAll());
      tb.appendChild(clearBtn);

      const priceHeader = document.querySelector('.chart-price-header');
      if (priceHeader) {
        const timeframes = document.getElementById('chart-timeframes');
        if (timeframes) {
          timeframes.parentNode.insertBefore(tb, timeframes.nextSibling);
        } else {
          priceHeader.appendChild(tb);
        }
      } else {
        const chartWrap = document.getElementById('gainex-chart');
        if (chartWrap) {
          chartWrap.style.position = 'relative';
          chartWrap.appendChild(tb);
        }
      }

      // Synchronize visibility state of the drawing toolbar
      if (window.DrawingToolbarPanel) {
        window.DrawingToolbarPanel.init();
      }

      document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (e.key === 'Delete' || e.key === 'Backspace') manager.deleteSelected();
        if (e.ctrlKey && e.key === 'z') { e.preventDefault(); manager.undo(); }
        if (e.ctrlKey && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); manager.redo(); }
        if (e.key === 'Escape') manager.setTool(null);
      });
    },

    setActive(toolId) {
      for (const [id, btn] of Object.entries(this._buttons)) {
        btn.classList.toggle('gxm-tb-active', id === toolId);
      }
    }
  };

  // ============================================================
  // PUBLIC CONTROLLER INTERFACE
  // ============================================================
  const DrawingEngine = {
    manager: null,
    magnetMode: false,
    _stylePanel: StylePanelManager,
    ToolbarManager: ToolbarManager,

    init() {
      const manager = new DrawingManager();
      this.manager = manager;

      manager.drawings = DrawingStorage.load();
      DrawingHistory.init(manager.drawings);

      DrawingRenderer.init(manager);
      GestureManager.init(manager);
      ToolbarManager.init(manager);

      DrawingRenderer.markDirty();

      window.addEventListener('resize', () => {
        DrawingRenderer.resize();
        DrawingRenderer.markDirty();
      });

      console.log('[GXM Enterprise Drawing Engine] Ready with', manager.drawings.length, 'drawings');
    },

    redraw() {
      DrawingRenderer.markDirty();
    },

    resize() {
      DrawingRenderer.resize();
    }
  };

  function tryInit() {
    const chartContainer = document.getElementById('gainex-chart');
    const chartReady = window.chart && window.chart.tvChart;
    if (chartContainer && chartReady) {
      DrawingEngine.init();
    } else {
      setTimeout(tryInit, 300);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(tryInit, 500));
  } else {
    setTimeout(tryInit, 500);
  }

  window.DrawingEngine = DrawingEngine;

})(window);
