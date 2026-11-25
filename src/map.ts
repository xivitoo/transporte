import type { Route, Stop, TransitMode, VehicleItem } from './types';

export interface MapCallbacks {
  onSelectStop: (stop: Stop) => void;
  onCameraChange?: (zoom: number) => void;
  onMapInteract?: () => void;
}

interface TileEntry {
  img: HTMLImageElement;
  loaded: boolean;
  failedAt: number;
  lastUsed: number;
}

const GRANADA_CENTER_LAT = 37.1773;
const GRANADA_CENTER_LON = -3.5986;
const MIN_LAT = 36.7;
const MAX_LAT = 37.7;
const MIN_LON = -4.35;
const MAX_LON = -2.5;
const CARTO_SUBDOMAINS = ['a', 'b', 'c', 'd'] as const;
const MAX_TILE_CACHE = 300;
const TILE_RETRY_MS = 10_000;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function latToMercatorY(lat: number): number {
  const rad = (clamp(lat, -85, 85) * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + rad / 2));
}

function lonToWorldX(lon: number): number {
  return (lon + 180) / 360;
}

function latToWorldY(lat: number): number {
  return (1 - latToMercatorY(lat) / Math.PI) / 2;
}

function worldYToLat(wy: number): number {
  const n = Math.PI - 2 * Math.PI * wy;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

export class GranadaTransitMap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tooltipEl: HTMLElement;
  private scaleEl: HTMLElement | null;
  private callbacks: MapCallbacks;

  private stops: Stop[] = [];
  private routes: Route[] = [];
  private visibleModes = new Set<TransitMode>(['urbano', 'interurbano', 'metro']);
  private selectedStop: Stop | null = null;
  private selectedRoute: Route | null = null;
  private vehicles: VehicleItem[] = [];
  private userLocation: { lat: number; lon: number } | null = null;
  private darkTheme = false;
  private showGlobalRoutes = false;

  // Cámara Web Mercator
  private centerLon = GRANADA_CENTER_LON;
  private centerLat = GRANADA_CENTER_LAT;
  private zoom = 13.0;
  private minZoom = 9.8;
  private maxZoom = 18.0;

  private width = 0;
  private height = 0;
  private dpr = 1;
  private rafPending = false;
  private animFrame: number | null = null;
  private inertiaFrame: number | null = null;

  // Caché de tiles CartoDB
  private tileCache = new Map<string, TileEntry>();
  private tileUseCounter = 0;

  // Estado de punteros / gestos táctiles
  private activePointers = new Map<number, { x: number; y: number }>();
  private isDragging = false;
  private isPinching = false;
  private dragMoved = false;
  private downPoint = { x: 0, y: 0 };
  private lastDragCenter = { x: 0, y: 0 };
  private lastPinchDist = 0;
  private lastPinchMid = { x: 0, y: 0 };
  private velocitySamples: Array<{ t: number; dx: number; dy: number }> = [];
  private lastTapTime = 0;
  private lastTapPos = { x: 0, y: 0 };
  private hoveredStop: Stop | null = null;

  private projectedStops: Array<{ stop: Stop; wx: number; wy: number }> = [];
  private projectedRoutes: Array<{
    route: Route;
    shapes: Array<{ direction: number; pts: Array<[number, number]> }>;
  }> = [];

  constructor(
    canvas: HTMLCanvasElement,
    tooltipEl: HTMLElement,
    scaleEl: HTMLElement | null,
    callbacks: MapCallbacks
  ) {
    this.canvas = canvas;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas2D no disponible');
    this.ctx = context;
    this.tooltipEl = tooltipEl;
    this.scaleEl = scaleEl;
    this.callbacks = callbacks;

    this.resize();
    this.bindEvents();
  }

  public setData(stops: Stop[], routes: Route[]) {
    this.stops = stops;
    this.routes = routes;
    this.projectedStops = stops.map((stop) => ({
      stop,
      wx: lonToWorldX(stop.lon),
      wy: latToWorldY(stop.lat),
    }));
    this.projectedRoutes = routes.map((route) => ({
      route,
      shapes: route.shapes.map((sh) => ({
        direction: sh.direction,
        pts: sh.points.map(([lat, lon]) => [lonToWorldX(lon), latToWorldY(lat)]),
      })),
    }));
    this.requestRender();
  }

  public setDarkTheme(dark: boolean) {
    if (this.darkTheme === dark) return;
    this.darkTheme = dark;
    this.requestRender();
  }

  public setVisibleModes(modes: Set<TransitMode>) {
    this.visibleModes = new Set(modes);
    this.requestRender();
  }

  public setShowGlobalRoutes(show: boolean) {
    if (this.showGlobalRoutes === show) return;
    this.showGlobalRoutes = show;
    this.requestRender();
  }

  public getShowGlobalRoutes(): boolean {
    return this.showGlobalRoutes;
  }

  public setSelectedStop(stop: Stop | null, fly = true, bottomClearancePx = 0) {
    this.selectedStop = stop;
    if (stop && fly) {
      const targetZoom = Math.max(this.zoom, 15.2);
      if (bottomClearancePx > 0) {
        const ws = 256 * Math.pow(2, targetZoom);
        const offsetWorldY = (bottomClearancePx * 0.5) / ws;
        const shiftedLat = worldYToLat(latToWorldY(stop.lat) + offsetWorldY);
        this.flyTo(shiftedLat, stop.lon, targetZoom);
      } else {
        this.flyTo(stop.lat, stop.lon, targetZoom);
      }
    } else {
      this.requestRender();
    }
  }

  public setSelectedRoute(route: Route | null, fit = true, bottomClearancePx = 0) {
    this.selectedRoute = route;
    if (route && fit && route.shapes.length > 0) {
      let minLat = 90;
      let maxLat = -90;
      let minLon = 180;
      let maxLon = -180;
      for (const sh of route.shapes) {
        for (const [lat, lon] of sh.points) {
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
        }
      }
      if (minLat < maxLat && minLon < maxLon) {
        const cLat = (minLat + maxLat) / 2;
        const cLon = (minLon + maxLon) / 2;
        const visibleH = Math.max(180, this.height - bottomClearancePx);
        const spanLat = Math.max(0.014, maxLat - minLat);
        const spanLon = Math.max(0.014, maxLon - minLon);
        const zoomLon = Math.log2((this.width * 0.65) / (256 * (spanLon / 360)));
        const zoomLat = Math.log2((visibleH * 0.65) / (256 * (spanLat / 180)));
        const targetZoom = clamp(Math.min(zoomLon, zoomLat), this.minZoom, 14.8);
        if (bottomClearancePx > 0) {
          const ws = 256 * Math.pow(2, targetZoom);
          const shiftedLat = worldYToLat(latToWorldY(cLat) + (bottomClearancePx * 0.5) / ws);
          this.flyTo(shiftedLat, cLon, targetZoom);
        } else {
          this.flyTo(cLat, cLon, targetZoom);
        }
        return;
      }
    }
    this.requestRender();
  }

  public setVehicles(vehicles: VehicleItem[]) {
    this.vehicles = vehicles;
    this.requestRender();
  }

  public setUserLocation(lat: number, lon: number, fly = true, bottomClearancePx = 0) {
    this.userLocation = { lat, lon };
    if (fly) {
      const targetZoom = 15.2;
      if (bottomClearancePx > 0) {
        const ws = 256 * Math.pow(2, targetZoom);
        const shiftedLat = worldYToLat(latToWorldY(lat) + (bottomClearancePx * 0.5) / ws);
        this.flyTo(shiftedLat, lon, targetZoom);
      } else {
        this.flyTo(lat, lon, targetZoom);
      }
    } else {
      this.requestRender();
    }
  }

  public resetView() {
    this.flyTo(GRANADA_CENTER_LAT, GRANADA_CENTER_LON, 13.0);
  }

  public zoomBy(delta: number, bottomClearancePx = 0) {
    const targetZoom = clamp(this.zoom + delta, this.minZoom, this.maxZoom);
    if (bottomClearancePx > 0 && this.height > bottomClearancePx) {
      // Mantener el punto visible central (encima de la hoja inferior móvil)
      const anchorX = this.width / 2;
      const anchorY = Math.max(40, (this.height - bottomClearancePx) / 2);
      const anchorGeo = this.screenToLatLon(anchorX, anchorY);
      const ws = 256 * Math.pow(2, targetZoom);
      const targetCenterWx = lonToWorldX(anchorGeo.lon) - (anchorX - this.width / 2) / ws;
      const targetCenterWy = latToWorldY(anchorGeo.lat) - (anchorY - this.height / 2) / ws;
      this.flyTo(worldYToLat(targetCenterWy), targetCenterWx * 360 - 180, targetZoom, 180);
      return;
    }
    this.flyTo(this.centerLat, this.centerLon, targetZoom, 180);
  }

  private stopAnimations() {
    if (this.animFrame !== null) {
      cancelAnimationFrame(this.animFrame);
      this.animFrame = null;
    }
    if (this.inertiaFrame !== null) {
      cancelAnimationFrame(this.inertiaFrame);
      this.inertiaFrame = null;
    }
  }

  public flyTo(lat: number, lon: number, targetZoom: number, duration = 280) {
    this.stopAnimations();
    const startLat = this.centerLat;
    const startLon = this.centerLon;
    const startZoom = this.zoom;
    const endLat = clamp(lat, MIN_LAT, MAX_LAT);
    const endLon = clamp(lon, MIN_LON, MAX_LON);
    const endZoom = clamp(targetZoom, this.minZoom, this.maxZoom);
    const startTime = performance.now();

    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced || duration <= 0) {
      this.centerLat = endLat;
      this.centerLon = endLon;
      this.zoom = endZoom;
      this.requestRender();
      this.callbacks.onCameraChange?.(this.zoom);
      return;
    }

    const step = (now: number) => {
      const t = Math.min(1, (now - startTime) / duration);
      const ease = 1 - Math.pow(1 - t, 3);
      this.centerLat = startLat + (endLat - startLat) * ease;
      this.centerLon = startLon + (endLon - startLon) * ease;
      this.zoom = startZoom + (endZoom - startZoom) * ease;
      this.render();
      if (t < 1) {
        this.animFrame = requestAnimationFrame(step);
      } else {
        this.animFrame = null;
        this.callbacks.onCameraChange?.(this.zoom);
      }
    };
    this.animFrame = requestAnimationFrame(step);
  }

  public resize() {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    this.width = Math.floor(rect.width);
    this.height = Math.floor(rect.height);
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.requestRender();
  }

  private get worldSize(): number {
    return 256 * Math.pow(2, this.zoom);
  }

  private worldToScreen(wx: number, wy: number): [number, number] {
    const ws = this.worldSize;
    const cx = lonToWorldX(this.centerLon) * ws;
    const cy = latToWorldY(this.centerLat) * ws;
    return [wx * ws - cx + this.width / 2, wy * ws - cy + this.height / 2];
  }

  private latLonToScreen(lat: number, lon: number): [number, number] {
    return this.worldToScreen(lonToWorldX(lon), latToWorldY(lat));
  }

  private screenToLatLon(sx: number, sy: number): { lat: number; lon: number } {
    const ws = this.worldSize;
    const cx = lonToWorldX(this.centerLon) * ws;
    const cy = latToWorldY(this.centerLat) * ws;
    const wx = (sx - this.width / 2 + cx) / ws;
    const wy = (sy - this.height / 2 + cy) / ws;
    return {
      lat: worldYToLat(wy),
      lon: wx * 360 - 180,
    };
  }

  private getTileUrl(style: 'rastertiles/voyager' | 'dark_all', z: number, x: number, y: number): string {
    const sub = CARTO_SUBDOMAINS[(x + y) % CARTO_SUBDOMAINS.length];
    const retina = this.dpr > 1 ? '@2x' : '';
    const apiKey = (import.meta.env.VITE_CARTODB_API_KEY as string | undefined)?.trim();
    const suffix = apiKey ? `?key=${encodeURIComponent(apiKey)}` : '';
    return `https://${sub}.basemaps.cartocdn.com/${style}/${z}/${x}/${y}${retina}.png${suffix}`;
  }

  private requestTile(style: 'rastertiles/voyager' | 'dark_all', z: number, x: number, y: number): TileEntry {
    const key = `${style}/${z}/${x}/${y}`;
    const existing = this.tileCache.get(key);
    const now = performance.now();

    if (existing) {
      existing.lastUsed = ++this.tileUseCounter;
      if (existing.failedAt > 0 && now - existing.failedAt > TILE_RETRY_MS && navigator.onLine) {
        existing.failedAt = 0;
        existing.img.src = this.getTileUrl(style, z, x, y);
      }
      return existing;
    }

    if (this.tileCache.size >= MAX_TILE_CACHE) {
      const sorted = Array.from(this.tileCache.entries()).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      for (let i = 0; i < 45 && i < sorted.length; i++) {
        this.tileCache.delete(sorted[i][0]);
      }
    }

    const img = new Image();
    img.decoding = 'async';
    const entry: TileEntry = {
      img,
      loaded: false,
      failedAt: 0,
      lastUsed: ++this.tileUseCounter,
    };
    this.tileCache.set(key, entry);

    img.onload = () => {
      entry.loaded = img.naturalWidth > 0;
      entry.failedAt = 0;
      this.requestRender();
    };
    img.onerror = () => {
      entry.failedAt = performance.now();
    };
    img.src = this.getTileUrl(style, z, x, y);
    return entry;
  }

  private drawCartoBasemap(ctx: CanvasRenderingContext2D) {
    const style = this.darkTheme ? 'dark_all' : 'rastertiles/voyager';
    const tileZoom = Math.max(9, Math.min(18, Math.round(this.zoom)));
    const numTiles = Math.pow(2, tileZoom);
    const ws = this.worldSize;
    const cx = lonToWorldX(this.centerLon) * ws;
    const cy = latToWorldY(this.centerLat) * ws;

    const topLeftWorldX = (cx - this.width / 2) / ws;
    const topLeftWorldY = (cy - this.height / 2) / ws;
    const bottomRightWorldX = (cx + this.width / 2) / ws;
    const bottomRightWorldY = (cy + this.height / 2) / ws;

    const minTx = Math.max(0, Math.floor(topLeftWorldX * numTiles));
    const maxTx = Math.min(numTiles - 1, Math.floor(bottomRightWorldX * numTiles));
    const minTy = Math.max(0, Math.floor(topLeftWorldY * numTiles));
    const maxTy = Math.min(numTiles - 1, Math.floor(bottomRightWorldY * numTiles));

    const tilePixelSize = ws / numTiles;

    for (let ty = minTy; ty <= maxTy; ty++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        const dx = (tx / numTiles) * ws - cx + this.width / 2;
        const dy = (ty / numTiles) * ws - cy + this.height / 2;
        const drawW = tilePixelSize + 0.75;
        const drawH = tilePixelSize + 0.75;

        const entry = this.requestTile(style, tileZoom, tx, ty);
        if (entry.loaded && entry.img.complete && entry.img.naturalWidth > 0) {
          ctx.drawImage(entry.img, dx, dy, drawW, drawH);
          continue;
        }

        // Respaldo progresivo desde tile padre en caché
        let drawnFallback = false;
        for (let shift = 1; shift <= 4; shift++) {
          const pz = tileZoom - shift;
          if (pz < 9) break;
          const ptx = tx >> shift;
          const pty = ty >> shift;
          const parent = this.tileCache.get(`${style}/${pz}/${ptx}/${pty}`);
          if (parent && parent.loaded && parent.img.complete && parent.img.naturalWidth > 0) {
            const subCount = 1 << shift;
            const subX = tx & (subCount - 1);
            const subY = ty & (subCount - 1);
            const sw = parent.img.naturalWidth / subCount;
            const sh = parent.img.naturalHeight / subCount;
            ctx.drawImage(parent.img, subX * sw, subY * sh, sw, sh, dx, dy, drawW, drawH);
            drawnFallback = true;
            break;
          }
        }

        if (!drawnFallback) {
          ctx.fillStyle = this.darkTheme ? '#232a3b' : '#dbe3ee';
          ctx.fillRect(dx, dy, drawW, drawH);
        }
      }
    }

    // Velo suave sin ctx.filter (compatible 100% con Safari/iOS WebKit) para suavizar modo oscuro pastel / contraste claro
    if (this.darkTheme) {
      ctx.fillStyle = 'rgba(42, 51, 74, 0.14)';
      ctx.fillRect(0, 0, this.width, this.height);
    }
  }

  private bindEvents() {
    const ro = new ResizeObserver(() => this.resize());
    if (this.canvas.parentElement) ro.observe(this.canvas.parentElement);

    // Recargar tiles pendientes si vuelve la conexión
    window.addEventListener('online', () => {
      for (const entry of this.tileCache.values()) {
        if (entry.failedAt > 0) entry.failedAt = 1;
      }
      this.requestRender();
    });

    const getCanvasPos = (clientX: number, clientY: number) => {
      const rect = this.canvas.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    };

    const recordVelocity = (dx: number, dy: number) => {
      const now = performance.now();
      this.velocitySamples.push({ t: now, dx, dy });
      while (this.velocitySamples.length > 0 && now - this.velocitySamples[0].t > 90) {
        this.velocitySamples.shift();
      }
    };

    const startInertia = () => {
      const now = performance.now();
      while (this.velocitySamples.length > 0 && now - this.velocitySamples[0].t > 90) {
        this.velocitySamples.shift();
      }
      if (this.velocitySamples.length < 2) return;

      const totalDx = this.velocitySamples.reduce((s, v) => s + v.dx, 0);
      const totalDy = this.velocitySamples.reduce((s, v) => s + v.dy, 0);
      const dt = Math.max(12, now - this.velocitySamples[0].t);
      let vx = (totalDx / dt) * 16;
      let vy = (totalDy / dt) * 16;
      if (Math.hypot(vx, vy) < 1.8) return;

      let lastT = performance.now();
      const step = (t: number) => {
        const frameFactor = Math.min(2, (t - lastT) / 16);
        lastT = t;
        this.panByPixels(vx * frameFactor, vy * frameFactor);
        const decay = Math.pow(0.91, frameFactor);
        vx *= decay;
        vy *= decay;
        if (Math.hypot(vx, vy) > 0.35) {
          this.inertiaFrame = requestAnimationFrame(step);
        } else {
          this.inertiaFrame = null;
        }
      };
      this.inertiaFrame = requestAnimationFrame(step);
    };

    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      this.stopAnimations();
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        // algunos navegadores móviles ignoran setPointerCapture en gestos sintéticos
      }

      const pos = getCanvasPos(e.clientX, e.clientY);
      this.activePointers.set(e.pointerId, pos);

      if (this.activePointers.size === 1) {
        this.isDragging = true;
        this.isPinching = false;
        this.dragMoved = false;
        this.downPoint = pos;
        this.lastDragCenter = pos;
        this.lastPinchDist = 0;
        this.velocitySamples = [];
      } else if (this.activePointers.size === 2) {
        const pts = Array.from(this.activePointers.values());
        this.isDragging = false;
        this.isPinching = true;
        this.dragMoved = true;
        this.velocitySamples = [];
        this.lastPinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        this.lastPinchMid = {
          x: (pts[0].x + pts[1].x) / 2,
          y: (pts[0].y + pts[1].y) / 2,
        };
        this.tooltipEl.classList.add('hidden');
        this.callbacks.onMapInteract?.();
      }
    });

    this.canvas.addEventListener('pointermove', (e) => {
      const pos = getCanvasPos(e.clientX, e.clientY);

      if (this.activePointers.has(e.pointerId)) {
        this.activePointers.set(e.pointerId, pos);
      }

      if (this.activePointers.size === 2) {
        const pts = Array.from(this.activePointers.values());
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const mid = {
          x: (pts[0].x + pts[1].x) / 2,
          y: (pts[0].y + pts[1].y) / 2,
        };

        if (!this.isPinching) {
          this.isPinching = true;
          this.dragMoved = true;
          this.lastPinchDist = dist;
          this.lastPinchMid = mid;
          return;
        }

        if (this.lastPinchDist > 12 && dist > 12) {
          // Anclar el punto geográfico bajo el centro anterior de los dedos al nuevo centro y zoom
          const anchorGeo = this.screenToLatLon(this.lastPinchMid.x, this.lastPinchMid.y);
          const nextZoom = clamp(this.zoom + Math.log2(dist / this.lastPinchDist), this.minZoom, this.maxZoom);
          this.zoom = nextZoom;
          const ws = this.worldSize;
          const newCxWx = lonToWorldX(anchorGeo.lon) - (mid.x - this.width / 2) / ws;
          const newCyWy = latToWorldY(anchorGeo.lat) - (mid.y - this.height / 2) / ws;
          this.centerLat = clamp(worldYToLat(newCyWy), MIN_LAT, MAX_LAT);
          this.centerLon = clamp(newCxWx * 360 - 180, MIN_LON, MAX_LON);
          this.requestRender();
          this.callbacks.onCameraChange?.(this.zoom);
        }

        this.lastPinchDist = dist;
        this.lastPinchMid = mid;
        this.dragMoved = true;
        return;
      }

      if (this.isDragging && this.activePointers.size === 1) {
        const tapSlop = e.pointerType === 'mouse' ? 6 : 12;
        if (!this.dragMoved && Math.hypot(pos.x - this.downPoint.x, pos.y - this.downPoint.y) > tapSlop) {
          this.dragMoved = true;
          this.callbacks.onMapInteract?.();
        }
        if (this.dragMoved) {
          const dx = pos.x - this.lastDragCenter.x;
          const dy = pos.y - this.lastDragCenter.y;
          this.panByPixels(dx, dy);
          recordVelocity(dx, dy);
          this.lastDragCenter = pos;
          this.tooltipEl.classList.add('hidden');
        }
        return;
      }

      if (e.pointerType === 'mouse') {
        const hit = this.findStopAt(pos.x, pos.y, 24);
        if (hit !== this.hoveredStop) {
          this.hoveredStop = hit;
          this.canvas.style.cursor = hit ? 'pointer' : 'grab';
          if (hit) {
            this.showTooltip(hit, pos.x, pos.y);
          } else {
            this.tooltipEl.classList.add('hidden');
          }
          this.requestRender();
        } else if (hit) {
          this.showTooltip(hit, pos.x, pos.y);
        }
      }
    });

    const endPointer = (e: PointerEvent) => {
      try {
        if (this.canvas.hasPointerCapture(e.pointerId)) {
          this.canvas.releasePointerCapture(e.pointerId);
        }
      } catch {
        // ignorar
      }

      if (!this.activePointers.has(e.pointerId)) return;
      this.activePointers.delete(e.pointerId);

      if (this.activePointers.size === 0) {
        const wasDragging = this.isDragging;
        const wasPinching = this.isPinching;
        const moved = this.dragMoved;

        this.isDragging = false;
        this.isPinching = false;
        this.lastPinchDist = 0;

        if (e.type === 'pointerup' && wasDragging && !wasPinching && !moved) {
          const pos = getCanvasPos(e.clientX, e.clientY);
          const maxDist = e.pointerType === 'mouse' ? 24 : 46;
          const hit = this.findStopAt(pos.x, pos.y, maxDist);

          if (hit) {
            this.lastTapTime = 0;
            this.callbacks.onSelectStop(hit);
          } else {
            const now = performance.now();
            const isDoubleTap =
              now - this.lastTapTime < 280 &&
              Math.hypot(pos.x - this.lastTapPos.x, pos.y - this.lastTapPos.y) < 32;

            if (isDoubleTap) {
              this.lastTapTime = 0;
              const tapGeo = this.screenToLatLon(pos.x, pos.y);
              const targetZoom = clamp(this.zoom + 1.4, this.minZoom, this.maxZoom);
              const ws = 256 * Math.pow(2, targetZoom);
              const targetCenterWx = lonToWorldX(tapGeo.lon) - (pos.x - this.width / 2) / ws;
              const targetCenterWy = latToWorldY(tapGeo.lat) - (pos.y - this.height / 2) / ws;
              this.flyTo(worldYToLat(targetCenterWy), targetCenterWx * 360 - 180, targetZoom, 220);
            } else {
              this.lastTapTime = now;
              this.lastTapPos = pos;
              this.callbacks.onMapInteract?.();
            }
          }
        } else if (e.type === 'pointerup' && wasDragging && moved && !wasPinching) {
          startInertia();
        }
        this.velocitySamples = [];
      } else if (this.activePointers.size === 1) {
        // Transición suave de pellizco (2 dedos) a arrastre (1 dedo) sin saltos
        const remaining = Array.from(this.activePointers.values())[0];
        this.isPinching = false;
        this.lastPinchDist = 0;
        this.isDragging = true;
        this.dragMoved = true;
        this.lastDragCenter = { x: remaining.x, y: remaining.y };
        this.velocitySamples = [];
      }
    };

    this.canvas.addEventListener('pointerup', endPointer);
    this.canvas.addEventListener('pointercancel', endPointer);
    this.canvas.addEventListener('lostpointercapture', endPointer);
    this.canvas.addEventListener('pointerleave', () => {
      if (!this.isDragging && this.activePointers.size === 0) {
        this.hoveredStop = null;
        this.tooltipEl.classList.add('hidden');
      }
    });

    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.stopAnimations();
        const pos = getCanvasPos(e.clientX, e.clientY);
        const rawDelta = e.deltaMode === 1 ? e.deltaY * 18 : e.deltaMode === 2 ? e.deltaY * 120 : e.deltaY;
        const step = clamp(-rawDelta * 0.0024, -0.55, 0.55);
        this.zoomAtPoint(pos.x, pos.y, this.zoom + step);
      },
      { passive: false }
    );
  }

  private panByPixels(dx: number, dy: number) {
    const ws = this.worldSize;
    const newCx = lonToWorldX(this.centerLon) * ws - dx;
    const newCy = latToWorldY(this.centerLat) * ws - dy;
    const wx = newCx / ws;
    const wy = newCy / ws;
    const lon = wx * 360 - 180;
    const lat = worldYToLat(wy);

    this.centerLat = clamp(lat, MIN_LAT, MAX_LAT);
    this.centerLon = clamp(lon, MIN_LON, MAX_LON);
    this.requestRender();
  }

  private zoomAtPoint(sx: number, sy: number, nextZoom: number) {
    const clamped = clamp(nextZoom, this.minZoom, this.maxZoom);
    if (clamped === this.zoom) return;
    const before = this.screenToLatLon(sx, sy);
    this.zoom = clamped;
    const ws = this.worldSize;
    const newCxWx = lonToWorldX(before.lon) - (sx - this.width / 2) / ws;
    const newCyWy = latToWorldY(before.lat) - (sy - this.height / 2) / ws;
    this.centerLat = clamp(worldYToLat(newCyWy), MIN_LAT, MAX_LAT);
    this.centerLon = clamp(newCxWx * 360 - 180, MIN_LON, MAX_LON);
    this.requestRender();
    this.callbacks.onCameraChange?.(this.zoom);
  }

  private showTooltip(stop: Stop, sx: number, sy: number) {
    const modeLabel = stop.mode === 'metro' ? 'Metro' : stop.mode === 'urbano' ? 'Bus Urbano' : 'Interurbano';
    const lines = stop.lines.length > 0 ? ` · L${stop.lines.slice(0, 4).join(', ')}` : '';
    this.tooltipEl.textContent = `${stop.name} (${modeLabel}${lines})`;
    const left = Math.min(this.width - 220, Math.max(12, sx + 12));
    const top = Math.max(12, sy - 34);
    this.tooltipEl.style.transform = `translate(${left}px, ${top}px)`;
    this.tooltipEl.classList.remove('hidden');
  }

  private isStopVisible(stop: Stop): boolean {
    const hasSelectedRoute = this.selectedRoute !== null;
    const isSelectedStop = this.selectedStop?.id === stop.id && this.selectedStop?.mode === stop.mode;
    const isHovered = this.hoveredStop?.id === stop.id && this.hoveredStop?.mode === stop.mode;
    const isOnSelectedRoute =
      hasSelectedRoute && this.selectedRoute!.mode === stop.mode && stop.lines.includes(this.selectedRoute!.id);

    if (isSelectedStop || isHovered || isOnSelectedRoute) return true;
    if (!this.visibleModes.has(stop.mode)) return false;

    const showUrbanStops = this.zoom >= 11.7 || hasSelectedRoute;
    const showInterStops = this.zoom >= 12.1 || hasSelectedRoute;
    const showMetroStops = this.zoom >= 9.8 || hasSelectedRoute;

    if (stop.mode === 'urbano') return showUrbanStops;
    if (stop.mode === 'interurbano') return showInterStops;
    return showMetroStops;
  }

  private findStopAt(sx: number, sy: number, maxDist: number): Stop | null {
    let best: Stop | null = null;
    let bestScore = Infinity;
    const selectedLineId = this.selectedRoute?.id;
    const selectedMode = this.selectedRoute?.mode;

    for (const item of this.projectedStops) {
      const { stop, wx, wy } = item;
      if (!this.isStopVisible(stop)) continue;
      const [x, y] = this.worldToScreen(wx, wy);
      if (x < -40 || y < -40 || x > this.width + 40 || y > this.height + 40) continue;
      const d = Math.hypot(x - sx, y - sy);
      if (d <= maxDist) {
        const onSelectedRoute =
          selectedLineId && selectedMode === stop.mode && stop.lines.includes(selectedLineId) ? -8 : 0;
        const modePriority = stop.mode === 'metro' ? -3 : stop.mode === 'urbano' ? -1 : 0;
        const score = d + onSelectedRoute + modePriority;
        if (score < bestScore) {
          bestScore = score;
          best = stop;
        }
      }
    }
    return best;
  }

  public requestRender() {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.render();
    });
  }

  private updateScaleBar() {
    if (!this.scaleEl) return;
    const metersPerPixel = (156543.03392 * Math.cos((this.centerLat * Math.PI) / 180)) / Math.pow(2, this.zoom);
    const targetMeters = metersPerPixel * 85;
    const steps = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
    let chosen = steps[0];
    for (const s of steps) {
      if (s <= targetMeters * 1.4) chosen = s;
    }
    const px = Math.round(chosen / metersPerPixel);
    const label = chosen >= 1000 ? `${chosen / 1000} km` : `${chosen} m`;
    this.scaleEl.style.width = `${Math.max(40, px)}px`;
    this.scaleEl.textContent = label;
  }

  private render() {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    if (w <= 0 || h <= 0) return;

    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    ctx.fillStyle = this.darkTheme ? '#1d2230' : '#dde4ee';
    ctx.fillRect(0, 0, w, h);

    // 1. Mapa base CartoDB
    this.drawCartoBasemap(ctx);

    const stopBorder = this.darkTheme ? '#1d2230' : '#ffffff';
    const labelBg = this.darkTheme ? 'rgba(37, 43, 59, 0.94)' : 'rgba(248, 250, 252, 0.96)';
    const labelText = this.darkTheme ? '#edf1f7' : '#0f172a';
    const labelStroke = this.darkTheme ? 'rgba(148, 163, 184, 0.35)' : 'rgba(100, 116, 139, 0.35)';

    // 2. Trazados de líneas de Granada
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const hasSelectedRoute = this.selectedRoute !== null;

    if (this.showGlobalRoutes || hasSelectedRoute) {
      for (const item of this.projectedRoutes) {
        const { route, shapes } = item;
        const isSelected =
          hasSelectedRoute && this.selectedRoute!.id === route.id && this.selectedRoute!.mode === route.mode;

        if (!isSelected) {
          if (!this.showGlobalRoutes || !this.visibleModes.has(route.mode)) continue;
        }

        const baseOpacity = hasSelectedRoute
          ? isSelected
            ? 0.96
            : 0.14
          : route.mode === 'metro'
            ? 0.88
            : route.mode === 'urbano'
              ? 0.62
              : 0.46;
        const baseWidth = isSelected
          ? 4.4
          : route.mode === 'metro'
            ? Math.max(2.6, Math.min(3.8, (this.zoom - 9.5) * 0.72))
            : route.mode === 'urbano'
              ? 1.85
              : 1.55;

        for (const sh of shapes) {
          if (sh.pts.length < 2) continue;
          let colorHex = `#${route.color || 'dc2626'}`;
          if (isSelected && shapes.length > 1 && sh.direction === 1) {
            colorHex = this.darkTheme ? '#93c5fd' : '#0284c7';
          }

          ctx.beginPath();
          for (let i = 0; i < sh.pts.length; i++) {
            const [x, y] = this.worldToScreen(sh.pts[i][0], sh.pts[i][1]);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }

          if (isSelected) {
            ctx.strokeStyle = this.darkTheme ? '#1d2230' : '#ffffff';
            ctx.globalAlpha = 0.88;
            ctx.lineWidth = baseWidth + 2.6;
            ctx.stroke();
          }

          ctx.strokeStyle = colorHex;
          ctx.globalAlpha = baseOpacity;
          ctx.lineWidth = baseWidth;
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    // 3. Paradas más grandes y muy fáciles de pulsar con el dedo
    const placedLabels: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];

    for (const item of this.projectedStops) {
      const { stop, wx, wy } = item;
      if (!this.isStopVisible(stop)) continue;

      const isSelectedStop = this.selectedStop?.id === stop.id && this.selectedStop?.mode === stop.mode;
      const isHovered = this.hoveredStop?.id === stop.id && this.hoveredStop?.mode === stop.mode;
      const isOnSelectedRoute =
        hasSelectedRoute && this.selectedRoute!.mode === stop.mode && stop.lines.includes(this.selectedRoute!.id);

      const [x, y] = this.worldToScreen(wx, wy);
      if (x < -30 || y < -30 || x > w + 30 || y > h + 30) continue;

      const modeColor = this.darkTheme
        ? stop.mode === 'metro'
          ? '#86efac'
          : stop.mode === 'urbano'
            ? '#f28b82'
            : '#93c5fd'
        : stop.mode === 'metro'
          ? '#059669'
          : stop.mode === 'urbano'
            ? '#dc2626'
            : '#2563eb';

      const baseR =
        stop.mode === 'metro'
          ? Math.max(7.6, Math.min(11.8, (this.zoom - 9.2) * 1.6))
          : isOnSelectedRoute
            ? 9.4
            : Math.max(6.4, Math.min(10.6, (this.zoom - 10.6) * 1.55));

      ctx.globalAlpha = hasSelectedRoute && !isOnSelectedRoute && !isSelectedStop && !isHovered ? 0.28 : 1;

      if (isSelectedStop) {
        ctx.beginPath();
        ctx.arc(x, y, baseR + 14, 0, Math.PI * 2);
        ctx.fillStyle = this.darkTheme
          ? stop.mode === 'metro'
            ? 'rgba(134,239,172,0.30)'
            : stop.mode === 'urbano'
              ? 'rgba(242,139,130,0.30)'
              : 'rgba(147,197,253,0.30)'
          : stop.mode === 'metro'
            ? 'rgba(5,150,105,0.26)'
            : stop.mode === 'urbano'
              ? 'rgba(220,38,38,0.26)'
              : 'rgba(37,99,235,0.26)';
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(x, y, isSelectedStop ? baseR + 4.2 : isHovered ? baseR + 2.8 : baseR, 0, Math.PI * 2);
      ctx.fillStyle = isSelectedStop
        ? modeColor
        : stop.mode === 'metro'
          ? this.darkTheme
            ? '#252b3b'
            : '#ffffff'
          : modeColor;
      ctx.fill();
      ctx.lineWidth = stop.mode === 'metro' ? 3.5 : 2.6;
      ctx.strokeStyle = stop.mode === 'metro' && !isSelectedStop ? modeColor : stopBorder;
      ctx.stroke();

      const shouldDrawLabel =
        isSelectedStop ||
        isHovered ||
        (stop.mode === 'metro' && this.zoom >= 13.5) ||
        (isOnSelectedRoute && this.zoom >= 14.0) ||
        this.zoom >= 15.8;

      if (shouldDrawLabel) {
        ctx.globalAlpha = 1;
        ctx.font = isSelectedStop
          ? '700 12.5px system-ui, -apple-system, sans-serif'
          : '600 11px system-ui, -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const text = stop.name;
        const tw = ctx.measureText(text).width + 14;
        const lx = x;
        const ly = y - (baseR + 17);
        const box = { x1: lx - tw / 2, y1: ly - 11, x2: lx + tw / 2, y2: ly + 11 };
        const overlaps =
          !isSelectedStop &&
          !isHovered &&
          placedLabels.some((b) => !(box.x2 < b.x1 || box.x1 > b.x2 || box.y2 < b.y1 || box.y1 > b.y2));

        if (!overlaps) {
          placedLabels.push(box);
          ctx.fillStyle = labelBg;
          ctx.beginPath();
          ctx.roundRect(box.x1, box.y1, tw, 22, 6);
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = labelStroke;
          ctx.stroke();
          ctx.fillStyle = labelText;
          ctx.fillText(text, lx, ly);
        }
      }
    }
    ctx.globalAlpha = 1;

    // 4. Vehículos interurbanos en ruta
    for (const v of this.vehicles) {
      const [vx, vy] = this.latLonToScreen(v.lat, v.lon);
      if (vx < -20 || vy < -20 || vx > w + 20 || vy > h + 20) continue;
      ctx.beginPath();
      ctx.arc(vx, vy, 9.5, 0, Math.PI * 2);
      ctx.fillStyle = '#0f172a';
      ctx.fill();
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = '#93c5fd';
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = '700 8.5px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('BUS', vx, vy + 0.5);
    }

    // 5. Ubicación del usuario
    if (this.userLocation) {
      const [ux, uy] = this.latLonToScreen(this.userLocation.lat, this.userLocation.lon);
      ctx.beginPath();
      ctx.arc(ux, uy, 17, 0, Math.PI * 2);
      ctx.fillStyle = this.darkTheme ? 'rgba(165, 180, 252, 0.28)' : 'rgba(79, 70, 229, 0.22)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(ux, uy, 7.5, 0, Math.PI * 2);
      ctx.fillStyle = this.darkTheme ? '#a5b4fc' : '#4f46e5';
      ctx.fill();
      ctx.lineWidth = 2.6;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }

    ctx.restore();
    this.updateScaleBar();
  }
}
