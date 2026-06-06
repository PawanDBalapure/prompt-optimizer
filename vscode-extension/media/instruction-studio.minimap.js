/**
 * Graph Minimap subsystem for Visual Rule Canvas (Instruction Studio).
 * Loaded dynamically in alphabetical order, BEFORE the main instruction-studio.js module.
 * Attaches a `MinimapEngine` Class directly onto globalThis (window).
 */
(function() {
  'use strict';

  var MinimapEngine = function(options) {
    this.minimapContainer = document.getElementById(options.minimapContainerId);
    this.focusRect = document.getElementById(options.focusRectId);
    this.viewportLayer = document.getElementById(options.viewportLayerId);
    this.canvas = document.getElementById('vMinimapCanvas');

    if (!this.minimapContainer || !this.focusRect) {
      console.warn('[Minimap] DOM Elements not found.');
      return;
    }

    this.minimapSize = options.minimapSize || { width: 140, height: 140 };
    if (this.canvas) {
      this.canvas.width = this.minimapSize.width;
      this.canvas.height = this.minimapSize.height;
    }
    this.onViewportChange = options.onViewportChange; // function(x, y) callback

    // Dynamic State Values
    this.worldBounds = { minX: 0, maxX: 1000, minY: 0, maxY: 1000 };
    this.viewport = { x: 0, y: 0, scale: 1, viewW: 800, viewH: 500 };

    this.isDragging = false;
    this.dragStartMouse = { x: 0, y: 0 };
    this.dragStartRect = { x: 0, y: 0 };

    this.animationFrameId = null;
    this.pendingStyleUpdate = null;

    this.initStyles();
    this.bindEvents();
  };

  MinimapEngine.prototype.initStyles = function() {
    this.minimapContainer.style.position = 'absolute';
    this.minimapContainer.style.bottom = '12px';
    this.minimapContainer.style.right = '12px';
    this.minimapContainer.style.width = this.minimapSize.width + 'px';
    this.minimapContainer.style.height = this.minimapSize.height + 'px';
    this.minimapContainer.style.background = 'rgba(0, 0, 0, 0.4)';
    this.minimapContainer.style.border = '1px solid var(--border)';
    this.minimapContainer.style.borderRadius = '6px';
    this.minimapContainer.style.overflow = 'hidden';
    this.minimapContainer.style.userSelect = 'none';
    this.minimapContainer.style.zIndex = '100';
    this.minimapContainer.style.boxShadow = '0 3px 10px rgba(0,0,0,0.5)';

    this.focusRect.style.position = 'absolute';
    this.focusRect.style.border = '1.5px solid var(--vscode-focusBorder, #007fd4)';
    this.focusRect.style.background = 'rgba(0, 127, 212, 0.15)';
    this.focusRect.style.cursor = 'move';
    this.focusRect.style.boxSizing = 'border-box';
    this.focusRect.style.pointerEvents = 'all';
    this.focusRect.style.zIndex = '101';
  };

  MinimapEngine.prototype.bindEvents = function() {
    var self = this;

    this.focusRect.addEventListener('mousedown', function(e) {
      e.stopPropagation();
      e.preventDefault();
      self.isDragging = true;
      self.dragStartMouse = { x: e.clientX, y: e.clientY };
      self.dragStartRect = {
        x: parseFloat(self.focusRect.style.left) || 0,
        y: parseFloat(self.focusRect.style.top) || 0
      };
    });

    this.minimapContainer.addEventListener('mousedown', function(e) {
      if (e.target === self.focusRect) { return; }
      e.stopPropagation(); e.preventDefault();

      var rect = self.minimapContainer.getBoundingClientRect();
      var clickX = e.clientX - rect.left;
      var clickY = e.clientY - rect.top;

      var dims = self.getRectDimensions();
      var targetL = clickX - dims.w / 2;
      var targetT = clickY - dims.h / 2;

      self.isDragging = true;
      self.dragStartMouse = { x: e.clientX, y: e.clientY };
      self.dragStartRect = {
        x: Math.max(0, Math.min(targetL, self.minimapSize.width - dims.w)),
        y: Math.max(0, Math.min(targetT, self.minimapSize.height - dims.h))
      };
      
      // Update directly to trigger immediate center on click
      self.syncFocusRect(self.dragStartRect.x, self.dragStartRect.y, dims.w, dims.h);
    });

    window.addEventListener('mousemove', function(e) {
      if (!self.isDragging) { return; }
      e.preventDefault(); e.stopPropagation();

      var dx = e.clientX - self.dragStartMouse.x;
      var dy = e.clientY - self.dragStartMouse.y;

      var targetL = self.dragStartRect.x + dx;
      var targetT = self.dragStartRect.y + dy;

      var dims = self.getRectDimensions();
      var bL = Math.max(0, Math.min(targetL, self.minimapSize.width - dims.w));
      var bT = Math.max(0, Math.min(targetT, self.minimapSize.height - dims.h));

      self.syncFocusRect(bL, bT, dims.w, dims.h);
    });

    window.addEventListener('mouseup', function() {
      self.isDragging = false;
    });
  };

  MinimapEngine.prototype.getRectDimensions = function() {
    var worldW = this.worldBounds.maxX - this.worldBounds.minX;
    var worldH = this.worldBounds.maxY - this.worldBounds.minY;
    if (worldW <= 0) worldW = 1000;
    if (worldH <= 0) worldH = 1000;

    // View width/height in world metrics
    var viewWorldW = this.viewport.viewW / this.viewport.scale;
    var viewWorldH = this.viewport.viewH / this.viewport.scale;

    var scaleX = this.minimapSize.width / worldW;
    var scaleY = this.minimapSize.height / worldH;

    // Constrain rectangle size to minimap layout
    var rectW = Math.max(15, Math.min(viewWorldW * scaleX, this.minimapSize.width));
    var rectH = Math.max(15, Math.min(viewWorldH * scaleY, this.minimapSize.height));

    return { w: rectW, h: rectH, scaleX: scaleX, scaleY: scaleY };
  };

  MinimapEngine.prototype.worldToMinimap = function(wx, wy) {
    var worldW = this.worldBounds.maxX - this.worldBounds.minX;
    var worldH = this.worldBounds.maxY - this.worldBounds.minY;
    if (worldW <= 0) worldW = 1000;
    if (worldH <= 0) worldH = 1000;

    var scaleX = this.minimapSize.width / worldW;
    var scaleY = this.minimapSize.height / worldH;

    return {
      x: (wx - this.worldBounds.minX) * scaleX,
      y: (wy - this.worldBounds.minY) * scaleY
    };
  };

  MinimapEngine.prototype.minimapToWorld = function(mx, my) {
    var worldW = this.worldBounds.maxX - this.worldBounds.minX;
    var worldH = this.worldBounds.maxY - this.worldBounds.minY;
    if (worldW <= 0) worldW = 1000;
    if (worldH <= 0) worldH = 1000;

    var scaleX = this.minimapSize.width / worldW;
    var scaleY = this.minimapSize.height / worldH;

    return {
      x: this.worldBounds.minX + (mx / scaleX),
      y: this.worldBounds.minY + (my / scaleY)
    };
  };

  MinimapEngine.prototype.syncFocusRect = function(left, top, w, h) {
    this.pendingStyleUpdate = { left: left, top: top, w: w, h: h };
    this.scheduleDraw();

    if (this.onViewportChange) {
      // Find the corresponding central point inside minimap
      var mx = left + w / 2;
      var my = top + h / 2;
      var worldCenter = this.minimapToWorld(mx, my);

      // Main graph coordinates from worldCenter (scale adjusted)
      var vx = this.viewport.viewW / 2 - (worldCenter.x * this.viewport.scale);
      var vy = this.viewport.viewH / 2 - (worldCenter.y * this.viewport.scale);

      this.onViewportChange(vx, vy);
    }
  };

  MinimapEngine.prototype.scheduleDraw = function() {
    var self = this;
    if (this.animationFrameId !== null) { return; }

    this.animationFrameId = requestAnimationFrame(function() {
      self.animationFrameId = null;
      var style = self.pendingStyleUpdate;
      if (!style) { return; }

      self.focusRect.style.left = style.left + 'px';
      self.focusRect.style.top = style.top + 'px';
      self.focusRect.style.width = style.w + 'px';
      self.focusRect.style.height = style.h + 'px';

      self.pendingStyleUpdate = null;
    });
  };

  /**
   * Draws the minified layout of nodes and edges inside the minimap canvas block.
   */
  MinimapEngine.prototype.drawMinifiedGraph = function(nodes, edges) {
    if (!this.canvas) { return; }
    var ctx = this.canvas.getContext('2d');
    if (!ctx) { return; }

    ctx.clearRect(0, 0, this.minimapSize.width, this.minimapSize.height);

    // Draw minified lines (Edges)
    var self = this;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    (edges || []).forEach(function(e) {
      var fromN = nodes.find(function(x) { return x.id === e.from; });
      var toN = nodes.find(function(x) { return x.id === e.to; });
      if (fromN && toN && fromN.__visible !== false && toN.__visible !== false) {
        var fromP = self.worldToMinimap(fromN.x + (fromN.w || 100)/2, fromN.y + (fromN.h || 30)/2);
        var toP = self.worldToMinimap(toN.x, toN.y + (toN.h || 30)/2);
        ctx.beginPath();
        ctx.moveTo(fromP.x, fromP.y);
        ctx.lineTo(toP.x, toP.y);
        ctx.stroke();
      }
    });

    // Draw minified nodes (Points/rectangles)
    (nodes || []).forEach(function(n) {
      if (n.__visible === false) { return; }
      var pos = self.worldToMinimap(n.x, n.y);
      var w = (n.w || 100) * (self.minimapSize.width / (self.worldBounds.maxX - self.worldBounds.minX));
      var h = (n.h || 30) * (self.minimapSize.height / (self.worldBounds.maxY - self.worldBounds.minY));
      
      // Node sizing fallbacks
      w = Math.max(3, w);
      h = Math.max(2, h);

      // Color nodes based on type
      if (n.type === 'persona') {
        ctx.fillStyle = '#45c48b'; // Emerald
      } else if (n.type === 'condition') {
        ctx.fillStyle = '#d3a21b'; // Amber
      } else if (n.type === 'file') {
        ctx.fillStyle = '#007fd4'; // Blue
      } else {
        ctx.fillStyle = 'rgba(128, 128, 128, 0.6)'; // Rule / standard
      }
      ctx.fillRect(pos.x, pos.y, w, h);
    });
  };

  /**
   * Refreshes world bounds from nodes array and synchronizes minimap dimensions.
   */
  MinimapEngine.prototype.synchronize = function(nodes, vPan, viewportContainer, edges) {
    if (!nodes || nodes.length === 0) { return; }
    
    // 1. Calculate active bounding box from nodes
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    nodes.forEach(function(n) {
      if (n.__visible === false) return;
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    });

    if (minX === Infinity) {
      minX = 0; maxX = 1000; minY = 0; maxY = 1000;
    } else {
      // Add healthy world border margin padding (e.g. 300px)
      var margin = 250;
      minX -= margin; maxX += margin;
      minY -= margin; maxY += margin;
    }

    this.worldBounds = { minX: minX, maxX: maxX, minY: minY, maxY: maxY };

    // Draw minified graph nodes/lines onto minimap canvas
    this.drawMinifiedGraph(nodes, edges);

    // 2. Synchronize current viewport metrics
    var clientW = viewportContainer.clientWidth;
    var clientH = viewportContainer.clientHeight;
    if (clientW <= 0) clientW = 800;
    if (clientH <= 0) clientH = 500;

    // Viewport position in world space
    var viewWorldLeft = (0 - vPan.x) / vPan.scale;
    var viewWorldTop = (0 - vPan.y) / vPan.scale;

    this.viewport = {
      x: vPan.x,
      y: vPan.y,
      scale: vPan.scale,
      viewW: clientW,
      viewH: clientH
    };

    // Calculate bounding rect position
    var mapLeftTop = this.worldToMinimap(viewWorldLeft, viewWorldTop);
    var dims = this.getRectDimensions();

    var boundedL = Math.max(0, Math.min(mapLeftTop.x, this.minimapSize.width - dims.w));
    var boundedT = Math.max(0, Math.min(mapLeftTop.y, this.minimapSize.height - dims.h));

    // Force non-feedback update to draw current position without trigger recursive callback loop
    this.pendingStyleUpdate = { left: boundedL, top: boundedT, w: dims.w, h: dims.h };
    this.scheduleDraw();
  };

  // Re-export onto global window scope
  globalThis.MinimapEngine = MinimapEngine;
})();
