import './index.css';
import { fetchLineVehicles, fetchStopArrivals, loadNetworkData } from './api';
import { GranadaTransitMap } from './map';
import { initOnlineStatus, initPWAInstall, initServiceWorker } from './pwa';
import type { Route, Stop, StopArrivalsResult, TransitMode, VehicleItem } from './types';

type ActiveTab = 'explorar' | 'lineas' | 'favoritos';
type ModeFilter = 'todos' | TransitMode;
type SheetSnap = 'peek' | 'half' | 'full';

interface AppState {
  tab: ActiveTab;
  modeFilter: ModeFilter;
  query: string;
  stops: Stop[];
  routes: Route[];
  routesByKey: Map<string, Route>;
  stopsByKey: Map<string, Stop>;
  selectedStop: Stop | null;
  selectedRoute: Route | null;
  arrivals: StopArrivalsResult | null;
  arrivalsLoading: boolean;
  lineVehicles: VehicleItem[];
  favorites: Set<string>;
  userPos: { lat: number; lon: number } | null;
  locating: boolean;
  locationError: string | null;
  sheetSnap: SheetSnap;
  darkTheme: boolean;
  showGlobalRoutes: boolean;
}

const FAVS_KEY = 'granada_mueve_favoritos_v1';
const THEME_KEY = 'granada_mueve_tema_v1';
const ROUTES_VIS_KEY = 'granada_mueve_rutas_v2';

function normalizeText(str: string): string {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

function walkingMinutes(meters: number): string {
  const mins = Math.max(1, Math.round(meters / 75));
  return `${mins} min a pie`;
}

function modeLabel(mode: TransitMode): string {
  if (mode === 'metro') return 'Metro';
  if (mode === 'urbano') return 'Bus Urbano';
  return 'Interurbano';
}

function modeAccentColor(mode: TransitMode, dark = false): string {
  if (dark) {
    if (mode === 'metro') return '#86efac';
    if (mode === 'urbano') return '#f28b82';
    return '#93c5fd';
  }
  if (mode === 'metro') return '#059669';
  if (mode === 'urbano') return '#dc2626';
  return '#2563eb';
}

function formatMinutes(min: number): string {
  if (min <= 0) return 'En parada';
  if (min === 1) return '1 min';
  return `${min} min`;
}

function loadFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAVS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.map(String)) : new Set();
  } catch {
    return new Set();
  }
}

function saveFavorites(favs: Set<string>) {
  try {
    localStorage.setItem(FAVS_KEY, JSON.stringify(Array.from(favs)));
  } catch {
    // ignorar si el almacenamiento está lleno
  }
}

function stopKey(stop: Stop): string {
  return `${stop.mode}:${stop.id}`;
}

function routeKey(route: Route): string {
  return `${route.mode}:${route.id}`;
}

function buildAppShell(): string {
  return `
    <div class="flex flex-col h-dvh w-screen overflow-hidden bg-[#dce3ee] text-slate-950 dark:bg-[#1d2230] dark:text-[#edf1f7]">
      <!-- Top Bar compacta estilo app nativa -->
      <header class="pt-[env(safe-area-inset-top)] shrink-0 border-b border-slate-300 dark:border-[#3c4660] bg-[#eef2f7]/95 dark:bg-[#252b3b]/95 backdrop-blur-md z-30">
        <div class="h-[54px] md:h-[60px] px-4 md:px-6 flex items-center justify-between gap-4 lg:gap-8">
          <!-- Marca (solo icono) -->
          <a href="${import.meta.env.BASE_URL}" id="brand-reset" aria-label="Granada Mueve — Inicio" title="Granada Mueve" class="inline-flex items-center justify-center shrink-0 focus-visible:outline-2 focus-visible:outline-emerald-700 rounded-xl min-w-[44px] min-h-[44px]">
            <img src="${import.meta.env.BASE_URL}icon.svg" alt="Granada Mueve" class="w-9 h-9 rounded-xl shrink-0 shadow-xs" />
          </a>

          <!-- Enlaces en escritorio -->
          <nav class="hidden md:flex items-center gap-8 text-[15px] font-semibold" aria-label="Navegación principal">
            <button data-nav="explorar" class="nav-link py-2 whitespace-nowrap shrink-0 border-b-2 border-transparent text-slate-700 hover:text-slate-950 dark:text-[#b4bfd4] dark:hover:text-[#edf1f7] ui-transition cursor-pointer">
              Explorar
            </button>
            <button data-nav="lineas" class="nav-link py-2 whitespace-nowrap shrink-0 border-b-2 border-transparent text-slate-700 hover:text-slate-950 dark:text-[#b4bfd4] dark:hover:text-[#edf1f7] ui-transition cursor-pointer">
              Líneas
            </button>
            <button data-nav="favoritos" class="nav-link py-2 whitespace-nowrap shrink-0 border-b-2 border-transparent text-slate-700 hover:text-slate-950 dark:text-[#b4bfd4] dark:hover:text-[#edf1f7] ui-transition cursor-pointer">
              Favoritos
            </button>
          </nav>

          <!-- Tema + Instalar PWA -->
          <div class="flex items-center gap-2.5 shrink-0">
            <button
              id="theme-toggle"
              type="button"
              aria-label="Cambiar tema claro u oscuro"
              class="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-2xl bg-white dark:bg-[#2f374b] border border-slate-300 dark:border-[#434e6b] text-slate-800 dark:text-[#edf1f7] hover:bg-slate-100 dark:hover:bg-[#384158] active:scale-95 ui-transition cursor-pointer shadow-xs"
            >
              <svg id="theme-icon-moon" class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
              <svg id="theme-icon-sun" class="w-5 h-5 hidden" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
            </button>
            <button
              id="pwa-install-btn"
              type="button"
              class="hidden min-h-[44px] px-4 py-2 rounded-2xl bg-slate-900 text-white dark:bg-[#7ee0c6] dark:text-[#18202c] dark:hover:bg-[#95e8d2] hover:bg-slate-800 text-sm font-bold whitespace-nowrap shrink-0 active:scale-95 ui-transition cursor-pointer shadow-xs"
            >
              Instalar app
            </button>
          </div>
        </div>
      </header>

      <!-- Workspace Principal -->
      <div class="relative flex-1 flex overflow-hidden">
        <!-- Mapa interactivo -->
        <main class="relative flex-1 h-full overflow-hidden bg-[#dde4ee] dark:bg-[#1d2230] md:order-2">
          <canvas id="transit-map" class="block w-full h-full touch-none select-none"></canvas>

          <!-- Selector GRANDE siempre visible para limpiar o rellenar el mapa en 1 toque -->
          <div class="absolute top-3 left-3 right-3 md:right-auto z-10 pointer-events-none flex justify-start">
            <div
              class="pointer-events-auto w-full md:w-auto grid grid-cols-4 md:inline-flex gap-1.5 p-1.5 rounded-2xl bg-[#eef2f7]/95 dark:bg-[#252b3b]/95 backdrop-blur-md border border-slate-300 dark:border-[#434e6b] shadow-lg"
              role="group"
              aria-label="Selector rápido de red en el mapa"
            >
              <button
                type="button"
                data-mode="todos"
                class="mode-btn min-h-[48px] md:min-h-[46px] px-2 md:px-4 rounded-xl text-[13px] md:text-sm font-bold whitespace-nowrap flex items-center justify-center gap-1.5 active:scale-95 ui-transition cursor-pointer"
              >
                Todos
              </button>
              <button
                type="button"
                data-mode="urbano"
                class="mode-btn min-h-[48px] md:min-h-[46px] px-2 md:px-4 rounded-xl text-[13px] md:text-sm font-bold whitespace-nowrap flex items-center justify-center gap-1.5 active:scale-95 ui-transition cursor-pointer"
              >
                <span class="w-2.5 h-2.5 rounded-full bg-red-600 dark:bg-[#f28b82] shrink-0"></span>
                <span>Urbano</span>
              </button>
              <button
                type="button"
                data-mode="interurbano"
                class="mode-btn min-h-[48px] md:min-h-[46px] px-1.5 md:px-4 rounded-xl text-[12.5px] md:text-sm font-bold whitespace-nowrap flex items-center justify-center gap-1.5 active:scale-95 ui-transition cursor-pointer"
              >
                <span class="w-2.5 h-2.5 rounded-full bg-blue-600 dark:bg-[#93c5fd] shrink-0"></span>
                <span class="sm:hidden">Interurb.</span>
                <span class="hidden sm:inline">Interurbano</span>
              </button>
              <button
                type="button"
                data-mode="metro"
                class="mode-btn min-h-[48px] md:min-h-[46px] px-2 md:px-4 rounded-xl text-[13px] md:text-sm font-bold whitespace-nowrap flex items-center justify-center gap-1.5 active:scale-95 ui-transition cursor-pointer"
              >
                <span class="w-2.5 h-2.5 rounded-full bg-emerald-600 dark:bg-[#86efac] shrink-0"></span>
                <span>Metro</span>
              </button>
            </div>
          </div>

          <!-- Tooltip flotante en escritorio -->
          <div
            id="map-tooltip"
            class="hidden pointer-events-none absolute top-0 left-0 z-10 px-3 py-2 rounded-xl bg-slate-900 text-white dark:bg-[#2f374b] dark:text-[#edf1f7] dark:border dark:border-[#434e6b] text-sm font-semibold shadow-md max-w-[280px] truncate"
          ></div>

          <!-- Controles flotantes del mapa (debajo del selector en móvil, esquina superior derecha en escritorio) -->
          <div class="absolute top-[74px] md:top-3 right-3 z-10 flex flex-col items-end gap-2.5">
            <div class="flex items-center gap-2">
              <button
                id="btn-toggle-routes"
                type="button"
                aria-pressed="false"
                title="Mostrar u ocultar líneas de rutas en el mapa global"
                class="min-h-[48px] px-3.5 inline-flex items-center gap-2 rounded-2xl border shadow-md text-xs md:text-sm font-bold whitespace-nowrap active:scale-95 ui-transition cursor-pointer"
              >
                <svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/></svg>
                <span id="btn-toggle-routes-label">Sin rutas</span>
              </button>
              <button
                id="btn-locate"
                type="button"
                title="Mi ubicación y paradas cercanas"
                aria-label="Mi ubicación"
                class="min-w-[48px] min-h-[48px] flex items-center justify-center rounded-2xl bg-[#eef2f7]/95 dark:bg-[#252b3b]/95 backdrop-blur-md border border-slate-300 dark:border-[#434e6b] text-slate-900 dark:text-[#edf1f7] shadow-md hover:bg-white dark:hover:bg-[#2f374b] active:scale-95 ui-transition cursor-pointer"
              >
                <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/><circle cx="12" cy="12" r="7"/></svg>
              </button>
            </div>
            <div class="flex flex-col rounded-2xl bg-[#eef2f7]/95 dark:bg-[#252b3b]/95 backdrop-blur-md border border-slate-300 dark:border-[#434e6b] shadow-md overflow-hidden">
              <button
                id="btn-zoom-in"
                type="button"
                aria-label="Acercar mapa"
                class="min-w-[48px] min-h-[48px] flex items-center justify-center text-slate-900 dark:text-[#edf1f7] hover:bg-white dark:hover:bg-[#2f374b] border-b border-slate-300 dark:border-[#434e6b] active:scale-95 ui-transition cursor-pointer"
              >
                <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
              </button>
              <button
                id="btn-zoom-out"
                type="button"
                aria-label="Alejar mapa"
                class="min-w-[48px] min-h-[48px] flex items-center justify-center text-slate-900 dark:text-[#edf1f7] hover:bg-white dark:hover:bg-[#2f374b] border-b border-slate-300 dark:border-[#434e6b] active:scale-95 ui-transition cursor-pointer"
              >
                <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M5 12h14"/></svg>
              </button>
              <button
                id="btn-reset-view"
                type="button"
                title="Centrar en Granada"
                aria-label="Centrar mapa en Granada"
                class="min-w-[48px] min-h-[48px] flex items-center justify-center text-slate-900 dark:text-[#edf1f7] hover:bg-white dark:hover:bg-[#2f374b] active:scale-95 ui-transition cursor-pointer"
              >
                <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
              </button>
            </div>
          </div>

          <!-- Leyenda y escala en escritorio -->
          <div class="hidden md:flex items-center gap-4 absolute bottom-3 left-3 z-10 px-3.5 py-2 rounded-xl bg-[#eef2f7]/95 dark:bg-[#252b3b]/95 backdrop-blur-md border border-slate-300 dark:border-[#434e6b] text-xs font-semibold text-slate-800 dark:text-[#d5dceb] shadow-sm">
            <span class="flex items-center gap-1.5"><span class="w-3 h-3 rounded-full bg-red-600 dark:bg-[#f28b82] inline-block"></span>Bus Urbano</span>
            <span class="flex items-center gap-1.5"><span class="w-3 h-3 rounded-full bg-blue-600 dark:bg-[#93c5fd] inline-block"></span>Interurbano</span>
            <span class="flex items-center gap-1.5"><span class="w-3 h-3 rounded-full bg-emerald-600 dark:bg-[#86efac] inline-block"></span>Metro</span>
          </div>

          <div class="hidden md:flex items-center gap-3 absolute bottom-3 right-3 z-10">
            <span class="px-2.5 py-1 rounded-lg bg-[#eef2f7]/90 dark:bg-[#252b3b]/90 text-[10px] font-medium text-slate-700 dark:text-[#b4bfd4] border border-slate-300/70 dark:border-[#434e6b]/70">
              © CARTO · OpenStreetMap
            </span>
            <div
              id="map-scale"
              class="px-2 py-0.5 text-[11px] font-mono-num font-semibold text-slate-800 dark:text-[#edf1f7] border-b-2 border-x border-slate-600 dark:border-[#8b98b8] bg-[#eef2f7]/90 dark:bg-[#252b3b]/90 text-center"
            >
              500 m
            </div>
          </div>

          <span class="md:hidden absolute top-[74px] left-3 z-10 px-2 py-0.5 rounded-md bg-[#eef2f7]/90 dark:bg-[#252b3b]/90 backdrop-blur-sm border border-slate-300/70 dark:border-[#434e6b]/70 text-[10px] font-medium text-slate-700 dark:text-[#b4bfd4] pointer-events-none">
            © CARTO · OSM
          </span>

          <!-- Aviso modo Offline -->
          <div
            id="offline-banner"
            class="hidden absolute top-[104px] md:top-[70px] left-3 z-20 px-3 py-1.5 rounded-xl bg-amber-700 dark:bg-[#eab308] dark:text-[#18202c] text-white text-xs font-bold shadow-md"
          >
            Offline · Red y horarios guardados
          </div>
        </main>

        <!-- Panel Lateral (Escritorio) / Hoja Inferior Deslizable 3 estados (Móvil) -->
        <aside
          id="side-panel"
          class="
            fixed md:static left-0 right-0 z-20
            bottom-[calc(66px+env(safe-area-inset-bottom))] md:bottom-auto
            h-[78dvh] md:h-full md:w-[440px] lg:w-[470px] md:shrink-0 md:order-1
            bg-[#eef2f7]/98 dark:bg-[#252b3b]/98 md:bg-[#eef2f7] md:dark:bg-[#252b3b] backdrop-blur-xl md:backdrop-blur-none
            border-t md:border-t-0 md:border-r border-slate-300 dark:border-[#3c4660]
            rounded-t-3xl md:rounded-none
            flex flex-col
            shadow-[0_-14px_36px_rgba(15,23,42,0.18)] md:shadow-none
            sheet-spring md:transform-none!
          "
        >
          <!-- Zona de arrastre táctil amplia móvil -->
          <div
            id="mobile-sheet-drag-zone"
            class="md:hidden min-h-[42px] px-4 pt-3 pb-2.5 shrink-0 touch-none select-none cursor-grab active:cursor-grabbing flex items-center justify-center"
          >
            <div class="w-14 h-1.5 rounded-full bg-slate-400 dark:bg-[#536080]"></div>
          </div>

          <!-- Buscador directo y grande -->
          <div class="px-4 pt-1 md:pt-4 pb-3 border-b border-slate-300 dark:border-[#3c4660] shrink-0">
            <div class="relative flex items-center">
              <svg class="w-5 h-5 text-slate-600 dark:text-[#98a5c2] absolute left-3.5 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
              <input
                id="search-input"
                type="search"
                autocomplete="off"
                placeholder="Buscar parada, código o línea..."
                class="w-full min-h-[50px] pl-11 pr-11 py-2.5 text-base font-medium rounded-2xl bg-white dark:bg-[#2f374b] text-slate-950 dark:text-[#edf1f7] placeholder:text-slate-500 dark:placeholder:text-[#96a3be] border border-slate-300 dark:border-[#434e6b] focus:border-slate-600 dark:focus:border-[#7ee0c6] focus:outline-none ui-transition shadow-2xs"
              />
              <button
                id="search-clear"
                type="button"
                aria-label="Limpiar búsqueda"
                class="hidden absolute right-1.5 min-w-[44px] min-h-[44px] flex items-center justify-center text-slate-600 dark:text-[#b4bfd4] hover:text-slate-950 dark:hover:text-white rounded-xl cursor-pointer"
              >
                <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
              </button>
            </div>
          </div>

          <!-- Contenido dinámico scrollable -->
          <div id="panel-body" class="flex-1 overflow-y-auto thin-scroll px-4 py-3.5 pb-8 md:pb-5">
            <div class="py-12 text-center text-base font-medium text-slate-700 dark:text-[#b4bfd4]">Cargando red de transporte de Granada...</div>
          </div>
        </aside>
      </div>

      <!-- Barra de pestañas inferior nativa (solo móvil) -->
      <nav
        aria-label="Pestañas principales"
        class="md:hidden fixed bottom-0 left-0 right-0 z-30 bg-[#eef2f7]/98 dark:bg-[#252b3b]/98 backdrop-blur-xl border-t border-slate-300 dark:border-[#3c4660] pb-[env(safe-area-inset-bottom)]"
      >
        <div class="grid grid-cols-3 h-[66px]">
          <button
            type="button"
            data-nav="explorar"
            class="nav-link-mob flex flex-col items-center justify-center gap-1 min-h-[50px] active:scale-95 ui-transition cursor-pointer"
          >
            <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>
            <span class="text-xs font-bold tracking-tight">Explorar</span>
          </button>
          <button
            type="button"
            data-nav="lineas"
            class="nav-link-mob flex flex-col items-center justify-center gap-1 min-h-[50px] active:scale-95 ui-transition cursor-pointer"
          >
            <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="14" rx="3"/><path d="M4 11h16"/><path d="M8 17v2"/><path d="M16 17v2"/><circle cx="8" cy="14" r="1"/><circle cx="16" cy="14" r="1"/></svg>
            <span class="text-xs font-bold tracking-tight">Líneas</span>
          </button>
          <button
            type="button"
            data-nav="favoritos"
            class="nav-link-mob flex flex-col items-center justify-center gap-1 min-h-[50px] active:scale-95 ui-transition cursor-pointer"
          >
            <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            <span class="text-xs font-bold tracking-tight">Favoritos</span>
          </button>
        </div>
      </nav>

      <!-- Modal de instalación iOS Safari -->
      <div id="ios-install-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4">
        <div class="w-full max-w-sm rounded-3xl bg-white dark:bg-[#252b3b] border border-slate-300 dark:border-[#434e6b] p-6 shadow-xl">
          <h3 class="text-base font-bold text-slate-950 dark:text-[#edf1f7]">Instalar en iPhone o iPad</h3>
          <p class="mt-2 text-sm text-slate-700 dark:text-[#b4bfd4] leading-relaxed">
            1. Pulsa el botón <strong>Compartir</strong> en la barra inferior de Safari.<br />
            2. Desliza y elige <strong>Añadir a pantalla de inicio</strong>.
          </p>
          <button
            id="ios-install-close"
            type="button"
            class="mt-5 w-full min-h-[48px] rounded-2xl bg-slate-900 dark:bg-[#7ee0c6] text-white dark:text-[#18202c] text-sm font-bold cursor-pointer"
          >
            Entendido
          </button>
        </div>
      </div>
    </div>
  `;
}

async function bootstrap() {
  const root = document.getElementById('app');
  if (!root) return;
  root.innerHTML = buildAppShell();

  initServiceWorker();

  const pwaInstallBtn = document.getElementById('pwa-install-btn') as HTMLButtonElement;
  const iosModal = document.getElementById('ios-install-modal') as HTMLElement;
  const iosCloseBtn = document.getElementById('ios-install-close') as HTMLButtonElement;
  initPWAInstall(pwaInstallBtn, iosModal, iosCloseBtn);
  initOnlineStatus(document.getElementById('offline-banner') as HTMLElement);

  const savedTheme = localStorage.getItem(THEME_KEY);
  const initialDark =
    savedTheme === 'dark' ||
    (!savedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches);

  const state: AppState = {
    tab: 'explorar',
    modeFilter: 'todos',
    query: '',
    stops: [],
    routes: [],
    routesByKey: new Map(),
    stopsByKey: new Map(),
    selectedStop: null,
    selectedRoute: null,
    arrivals: null,
    arrivalsLoading: false,
    lineVehicles: [],
    favorites: loadFavorites(),
    userPos: null,
    locating: false,
    locationError: null,
    sheetSnap: 'peek',
    darkTheme: initialDark,
    showGlobalRoutes: localStorage.getItem(ROUTES_VIS_KEY) === 'true',
  };

  const sidePanel = document.getElementById('side-panel') as HTMLElement;
  const dragZone = document.getElementById('mobile-sheet-drag-zone') as HTMLElement;
  const panelBody = document.getElementById('panel-body') as HTMLElement;
  const searchInput = document.getElementById('search-input') as HTMLInputElement;
  const searchClear = document.getElementById('search-clear') as HTMLButtonElement;
  const toggleRoutesBtn = document.getElementById('btn-toggle-routes') as HTMLButtonElement;
  const toggleRoutesLabel = document.getElementById('btn-toggle-routes-label') as HTMLElement;

  const isMobile = () => window.innerWidth < 768;

  const getSheetTranslateY = (snap: SheetSnap): number => {
    const h = sidePanel.offsetHeight || window.innerHeight * 0.78;
    const peekVisiblePx = 108;
    if (snap === 'full') return 0;
    if (snap === 'half') return Math.round(h * 0.42);
    return Math.max(0, h - peekVisiblePx);
  };

  const getMobileBottomClearance = (): number => {
    if (!isMobile()) return 0;
    const h = sidePanel.offsetHeight || window.innerHeight * 0.78;
    const visibleSheet = h - getSheetTranslateY(state.sheetSnap);
    return Math.max(0, visibleSheet + 66);
  };

  const applySheetSnap = (snap: SheetSnap, animate = true) => {
    state.sheetSnap = snap;
    if (!isMobile()) {
      sidePanel.style.transform = '';
      return;
    }
    sidePanel.classList.toggle('sheet-spring', animate);
    const y = getSheetTranslateY(snap);
    sidePanel.style.transform = `translateY(${y}px)`;
  };

  const map = new GranadaTransitMap(
    document.getElementById('transit-map') as HTMLCanvasElement,
    document.getElementById('map-tooltip') as HTMLElement,
    document.getElementById('map-scale'),
    {
      onSelectStop: (stop) => {
        selectStop(stop);
      },
      onMapInteract: () => {
        if (isMobile() && state.sheetSnap !== 'peek') {
          applySheetSnap('peek', true);
        }
      },
    }
  );

  const applyTheme = (dark: boolean) => {
    state.darkTheme = dark;
    document.documentElement.classList.toggle('dark', dark);
    document.getElementById('theme-icon-moon')?.classList.toggle('hidden', dark);
    document.getElementById('theme-icon-sun')?.classList.toggle('hidden', !dark);
    try {
      localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
    } catch {
      // ignorar
    }
    map.setDarkTheme(dark);
  };

  applyTheme(state.darkTheme);

  const syncGlobalRoutesButton = (show: boolean) => {
    state.showGlobalRoutes = show;
    map.setShowGlobalRoutes(show);
    toggleRoutesBtn.setAttribute('aria-pressed', String(show));
    toggleRoutesLabel.textContent = show ? 'Rutas' : 'Sin rutas';
    if (show) {
      toggleRoutesBtn.className =
        'min-h-[48px] px-3.5 inline-flex items-center gap-2 rounded-2xl border shadow-md text-xs md:text-sm font-bold whitespace-nowrap active:scale-95 ui-transition cursor-pointer bg-slate-900 text-white border-slate-900 dark:bg-[#7ee0c6] dark:text-[#18202c] dark:border-[#7ee0c6]';
    } else {
      toggleRoutesBtn.className =
        'min-h-[48px] px-3.5 inline-flex items-center gap-2 rounded-2xl border shadow-md text-xs md:text-sm font-bold whitespace-nowrap active:scale-95 ui-transition cursor-pointer bg-[#eef2f7]/95 text-slate-800 border-slate-300 dark:bg-[#252b3b]/95 dark:text-[#edf1f7] dark:border-[#434e6b]';
    }
    try {
      localStorage.setItem(ROUTES_VIS_KEY, String(show));
    } catch {
      // ignorar
    }
  };
  syncGlobalRoutesButton(state.showGlobalRoutes);

  // Gestos táctiles reales de arrastre para el Bottom Sheet móvil
  let sheetDragging = false;
  let sheetStartY = 0;
  let sheetBaseTranslate = 0;
  let sheetCurrentTranslate = 0;
  let sheetLastY = 0;
  let sheetVelocityY = 0;
  let sheetLastTime = 0;

  dragZone.addEventListener('pointerdown', (e) => {
    if (!isMobile()) return;
    sheetDragging = true;
    sheetStartY = e.clientY;
    sheetLastY = e.clientY;
    sheetLastTime = performance.now();
    sheetVelocityY = 0;
    sheetBaseTranslate = getSheetTranslateY(state.sheetSnap);
    sheetCurrentTranslate = sheetBaseTranslate;
    sidePanel.classList.remove('sheet-spring');
    dragZone.setPointerCapture(e.pointerId);
  });

  dragZone.addEventListener('pointermove', (e) => {
    if (!sheetDragging) return;
    const now = performance.now();
    const dt = Math.max(1, now - sheetLastTime);
    sheetVelocityY = (e.clientY - sheetLastY) / dt;
    sheetLastY = e.clientY;
    sheetLastTime = now;

    const maxT = getSheetTranslateY('peek');
    const raw = sheetBaseTranslate + (e.clientY - sheetStartY);
    sheetCurrentTranslate = Math.max(0, Math.min(maxT, raw));
    sidePanel.style.transform = `translateY(${sheetCurrentTranslate}px)`;
  });

  const endSheetDrag = (e: PointerEvent) => {
    if (!sheetDragging) return;
    sheetDragging = false;
    if (dragZone.hasPointerCapture(e.pointerId)) {
      dragZone.releasePointerCapture(e.pointerId);
    }

    if (Math.abs(e.clientY - sheetStartY) < 6) {
      applySheetSnap(state.sheetSnap === 'peek' ? 'half' : 'peek');
      return;
    }

    const halfT = getSheetTranslateY('half');
    const peekT = getSheetTranslateY('peek');
    const projected = sheetCurrentTranslate + sheetVelocityY * 140;

    const snaps: Array<{ name: SheetSnap; y: number }> = [
      { name: 'full', y: 0 },
      { name: 'half', y: halfT },
      { name: 'peek', y: peekT },
    ];
    snaps.sort((a, b) => Math.abs(a.y - projected) - Math.abs(b.y - projected));
    applySheetSnap(snaps[0].name, true);
  };

  dragZone.addEventListener('pointerup', endSheetDrag);
  dragZone.addEventListener('pointercancel', endSheetDrag);

  window.addEventListener('resize', () => {
    applySheetSnap(state.sheetSnap, false);
  });

  let arrivalsTimer: number | null = null;
  const stopAutoRefresh = () => {
    if (arrivalsTimer !== null) {
      window.clearInterval(arrivalsTimer);
      arrivalsTimer = null;
    }
  };

  const refreshSelectedStopArrivals = async (silent = false) => {
    const stop = state.selectedStop;
    if (!stop) return;
    if (!silent) {
      state.arrivalsLoading = true;
      renderPanel();
    }
    const res = await fetchStopArrivals(stop, state.routesByKey);
    if (state.selectedStop && stopKey(state.selectedStop) === stopKey(stop)) {
      const prevScroll = panelBody.scrollTop;
      state.arrivals = res;
      state.arrivalsLoading = false;
      map.setVehicles(res.vehicles);
      renderPanel();
      if (silent) panelBody.scrollTop = prevScroll;
    }
  };

  const selectStop = async (stop: Stop) => {
    stopAutoRefresh();
    state.selectedStop = stop;
    state.arrivals = null;
    state.arrivalsLoading = true;
    applySheetSnap('half');
    map.setSelectedStop(stop, true, getMobileBottomClearance());
    renderPanel();

    await refreshSelectedStopArrivals(false);
    arrivalsTimer = window.setInterval(() => {
      void refreshSelectedStopArrivals(true);
    }, 25_000);
  };

  const selectRoute = async (route: Route) => {
    stopAutoRefresh();
    state.selectedRoute = route;
    state.selectedStop = null;
    state.arrivals = null;
    state.lineVehicles = [];
    applySheetSnap('half');
    map.setSelectedStop(null, false);
    map.setSelectedRoute(route, true, getMobileBottomClearance());
    renderPanel();

    if (route.mode === 'interurbano') {
      const vehicles = await fetchLineVehicles(route);
      if (state.selectedRoute && routeKey(state.selectedRoute) === routeKey(route)) {
        state.lineVehicles = vehicles;
        map.setVehicles(vehicles);
        renderPanel();
      }
    } else {
      map.setVehicles([]);
    }
  };

  const clearSelection = () => {
    stopAutoRefresh();
    state.selectedStop = null;
    state.selectedRoute = null;
    state.arrivals = null;
    state.lineVehicles = [];
    map.setSelectedStop(null, false);
    map.setSelectedRoute(null, false);
    map.setVehicles([]);
    renderPanel();
  };

  const updateNavAndModeButtons = () => {
    document.querySelectorAll<HTMLButtonElement>('.nav-link').forEach((btn) => {
      const active = btn.dataset.nav === state.tab;
      btn.classList.toggle('border-slate-950', active);
      btn.classList.toggle('dark:border-[#7ee0c6]', active);
      btn.classList.toggle('text-slate-950', active);
      btn.classList.toggle('dark:text-[#edf1f7]', active);
      btn.classList.toggle('border-transparent', !active);
    });

    document.querySelectorAll<HTMLButtonElement>('.nav-link-mob').forEach((btn) => {
      const active = btn.dataset.nav === state.tab;
      btn.classList.toggle('text-emerald-800', active);
      btn.classList.toggle('dark:text-[#7ee0c6]', active);
      btn.classList.toggle('text-slate-600', !active);
      btn.classList.toggle('dark:text-[#98a5c2]', !active);
    });

    document.querySelectorAll<HTMLButtonElement>('.mode-btn').forEach((btn) => {
      const mode = btn.dataset.mode as ModeFilter;
      const active = mode === state.modeFilter;
      btn.setAttribute('aria-pressed', String(active));

      if (active) {
        btn.className =
          'mode-btn min-h-[48px] md:min-h-[46px] px-2 md:px-4 rounded-xl text-[13px] md:text-sm font-extrabold whitespace-nowrap flex items-center justify-center gap-1.5 active:scale-95 ui-transition cursor-pointer bg-slate-900 text-white shadow-sm dark:bg-[#7ee0c6] dark:text-[#18202c]';
      } else {
        btn.className =
          'mode-btn min-h-[48px] md:min-h-[46px] px-2 md:px-4 rounded-xl text-[13px] md:text-sm font-bold whitespace-nowrap flex items-center justify-center gap-1.5 active:scale-95 ui-transition cursor-pointer bg-white/80 text-slate-800 hover:bg-white dark:bg-[#2f374b] dark:text-[#d5dceb] dark:hover:bg-[#384158]';
      }
    });
  };

  const matchesMode = (mode: TransitMode): boolean =>
    state.modeFilter === 'todos' || state.modeFilter === mode;

  const renderLineBadge = (id: string, color: string, textColor: string, mode: TransitMode, large = false) => {
    const bg = color && color !== 'FFFFFF' ? `#${color}` : modeAccentColor(mode, false);
    const fg = textColor && color !== 'FFFFFF' ? `#${textColor}` : '#ffffff';
    const sizeCls = large
      ? 'min-w-[3.25rem] h-10 px-2.5 rounded-xl text-base font-extrabold'
      : 'min-w-[3rem] h-8 px-2 rounded-lg text-sm font-bold';
    return `<span class="inline-flex items-center justify-center ${sizeCls} tabular-nums shrink-0 shadow-2xs" style="background-color:${escapeHtml(bg)};color:${escapeHtml(fg)}">${escapeHtml(id)}</span>`;
  };

  const renderStopRow = (stop: Stop, distanceMeters?: number) => {
    const isFav = state.favorites.has(stopKey(stop));
    const linesStr = stop.lines.length > 0 ? `Líneas ${stop.lines.slice(0, 5).join(', ')}` : 'Parada';
    const distStr =
      distanceMeters !== undefined
        ? ` · ${formatDistance(distanceMeters)} (${walkingMinutes(distanceMeters)})`
        : '';
    const munStr = stop.municipality ? ` · ${stop.municipality}` : '';
    const dotColor = modeAccentColor(stop.mode, state.darkTheme);
    return `
      <button
        type="button"
        data-stop-key="${escapeHtml(stopKey(stop))}"
        class="stop-row w-full min-h-[68px] py-3 px-3.5 mb-2 rounded-2xl bg-white dark:bg-[#2f374b] border border-slate-300 dark:border-[#434e6b] flex items-center justify-between gap-3 text-left hover:border-slate-400 dark:hover:border-[#7ee0c6] active:scale-[0.99] ui-transition cursor-pointer shadow-2xs"
      >
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2.5">
            <span class="w-3 h-3 rounded-full shrink-0" style="background-color:${dotColor}"></span>
            <span class="text-[15px] md:text-base font-bold text-slate-950 dark:text-[#edf1f7] truncate">${escapeHtml(stop.name)}</span>
          </div>
          <div class="mt-1 pl-5.5 text-[13px] font-medium text-slate-700 dark:text-[#b4bfd4] truncate tabular-nums">
            ${escapeHtml(modeLabel(stop.mode))} · Cód. ${escapeHtml(stop.code)}${escapeHtml(munStr)}${escapeHtml(distStr)} · ${escapeHtml(linesStr)}
          </div>
        </div>
        <span class="text-lg font-bold ${isFav ? 'text-amber-500 dark:text-[#fcd34d]' : 'text-slate-500 dark:text-[#98a5c2]'} shrink-0">${isFav ? '★' : '›'}</span>
      </button>
    `;
  };

  const renderRouteRow = (route: Route) => {
    return `
      <button
        type="button"
        data-route-key="${escapeHtml(routeKey(route))}"
        class="route-row w-full min-h-[64px] py-3 px-3.5 mb-2 rounded-2xl bg-white dark:bg-[#2f374b] border border-slate-300 dark:border-[#434e6b] flex items-center gap-3.5 text-left hover:border-slate-400 dark:hover:border-[#7ee0c6] active:scale-[0.99] ui-transition cursor-pointer shadow-2xs"
      >
        ${renderLineBadge(route.id, route.color, route.textColor, route.mode)}
        <div class="min-w-0 flex-1">
          <div class="text-[15px] md:text-base font-bold text-slate-950 dark:text-[#edf1f7] truncate">${escapeHtml(route.name)}</div>
          <div class="mt-0.5 text-[13px] font-medium text-slate-700 dark:text-[#b4bfd4]">${escapeHtml(modeLabel(route.mode))}</div>
        </div>
        <span class="text-slate-500 dark:text-[#98a5c2] text-lg font-bold shrink-0">›</span>
      </button>
    `;
  };

  const renderArrivalRows = (items: StopArrivalsResult['arrivals'], mode: TransitMode, isTheoretical = false) =>
    items
      .map((a) => {
        const urgent = !isTheoretical && a.minutes <= 2;
        return `
      <div class="p-3.5 mb-2 rounded-2xl bg-white dark:bg-[#2f374b] border border-slate-300 dark:border-[#434e6b] flex items-center justify-between gap-3 shadow-2xs">
        <div class="flex items-center gap-3.5 min-w-0">
          ${renderLineBadge(a.lineId, a.color, a.textColor, mode, true)}
          <div class="min-w-0">
            <div class="text-[15px] md:text-base font-bold text-slate-950 dark:text-[#edf1f7] truncate">${escapeHtml(a.destination)}</div>
            ${
              a.timeText
                ? `<div class="text-[13px] font-medium text-slate-700 dark:text-[#b4bfd4] tabular-nums">${isTheoretical ? 'Hora Offline' : 'Hora'} ${escapeHtml(a.timeText)}${a.inRoute ? ' · En ruta' : ''}</div>`
                : ''
            }
          </div>
        </div>
        <div class="text-right shrink-0 pl-2">
          <span class="inline-flex items-center justify-center px-2.5 py-1 rounded-xl text-xl font-extrabold tabular-nums ${
            urgent
              ? 'bg-emerald-100 text-emerald-900 dark:bg-[#7ee0c6]/20 dark:text-[#7ee0c6]'
              : 'text-slate-950 dark:text-[#edf1f7]'
          }">${escapeHtml(formatMinutes(a.minutes))}</span>
        </div>
      </div>
    `;
      })
      .join('');

  const renderStopDetail = (stop: Stop) => {
    const isFav = state.favorites.has(stopKey(stop));
    const mun = stop.municipality ? ` · ${stop.municipality}` : '';

    let arrivalsHtml = '';
    if (state.arrivalsLoading && !state.arrivals) {
      arrivalsHtml = `
        <div class="space-y-2 py-2" aria-busy="true">
          <div class="h-16 rounded-2xl bg-white/80 dark:bg-[#2f374b]/70 border border-slate-300 dark:border-[#434e6b] animate-pulse"></div>
          <div class="h-16 rounded-2xl bg-white/80 dark:bg-[#2f374b]/70 border border-slate-300 dark:border-[#434e6b] animate-pulse"></div>
          <div class="h-16 rounded-2xl bg-white/80 dark:bg-[#2f374b]/70 border border-slate-300 dark:border-[#434e6b] animate-pulse"></div>
        </div>
      `;
    } else if (state.arrivals) {
      const { source, arrivals, gtfsDayLabel, hasGtfsData, vehicles, error } = state.arrivals;
      const sourceText =
        source === 'realtime'
          ? 'Online'
          : source === 'gtfs'
            ? `Offline${gtfsDayLabel ? ` · ${gtfsDayLabel}` : ''}`
            : 'Offline';

      if (arrivals.length === 0) {
        const emptyHint =
          source === 'unavailable' && !hasGtfsData
            ? 'No hay horarios Offline guardados todavía para esta parada.'
            : '';
        arrivalsHtml = `
          <div class="flex items-center justify-between gap-2 text-[13px] font-semibold text-slate-700 dark:text-[#b4bfd4] mb-2">
            <span>${escapeHtml(sourceText)}</span>
            <button id="btn-refresh-arrivals" type="button" class="min-h-[42px] px-3 rounded-xl bg-white dark:bg-[#2f374b] border border-slate-300 dark:border-[#434e6b] font-bold text-slate-900 dark:text-[#edf1f7] active:scale-95 cursor-pointer shrink-0">
              ${state.arrivalsLoading ? 'Actualizando...' : 'Actualizar'}
            </button>
          </div>
          <div class="py-6 px-4 rounded-2xl bg-white dark:bg-[#2f374b] border border-slate-300 dark:border-[#434e6b] text-center space-y-1.5">
            <p class="text-[15px] font-bold text-slate-900 dark:text-[#edf1f7]">${escapeHtml(error || 'No hay salidas próximas registradas ahora mismo')}</p>
            ${emptyHint ? `<p class="text-xs font-medium text-slate-600 dark:text-[#b4bfd4]">${escapeHtml(emptyHint)}</p>` : ''}
            ${
              vehicles.length > 0
                ? `<p class="text-sm font-semibold text-emerald-800 dark:text-[#7ee0c6]">${vehicles.length} vehículos activos en el mapa para esta línea.</p>`
                : ''
            }
          </div>
        `;
      } else {
        const isGtfsFallback = source === 'gtfs';
        arrivalsHtml = `
          <div class="flex items-center justify-between gap-2 text-[13px] font-semibold text-slate-700 dark:text-[#b4bfd4] mb-2">
            <span class="inline-flex items-center gap-1.5 ${isGtfsFallback ? 'text-amber-800 dark:text-[#fcd34d]' : ''}">
              <span class="w-2 h-2 rounded-full ${isGtfsFallback ? 'bg-amber-600 dark:bg-[#fcd34d]' : 'bg-emerald-600 dark:bg-[#7ee0c6]'}"></span>
              ${escapeHtml(sourceText)}
            </span>
            <button id="btn-refresh-arrivals" type="button" class="min-h-[42px] px-3 rounded-xl bg-white dark:bg-[#2f374b] border border-slate-300 dark:border-[#434e6b] font-bold text-slate-900 dark:text-[#edf1f7] active:scale-95 cursor-pointer shrink-0">
              ${state.arrivalsLoading ? 'Actualizando...' : 'Actualizar'}
            </button>
          </div>
          ${
            isGtfsFallback && error
              ? `<p class="mb-2.5 px-3 py-2 rounded-xl bg-amber-100/90 dark:bg-[#fcd34d]/15 border border-amber-300 dark:border-[#fcd34d]/40 text-xs font-semibold text-amber-900 dark:text-[#fde68a]">${escapeHtml(error)}</p>`
              : ''
          }
          <div>
            ${renderArrivalRows(arrivals, stop.mode, isGtfsFallback)}
          </div>
        `;
      }
    }

    const passingRoutes = stop.lines
      .map((lineId) => state.routesByKey.get(`${stop.mode}:${lineId}`))
      .filter((r): r is Route => Boolean(r));

    return `
      <div class="space-y-3.5">
        <div class="flex items-center justify-between gap-2">
          <button id="btn-back-detail" type="button" class="min-h-[46px] px-3 -ml-1 inline-flex items-center gap-1.5 rounded-xl bg-white dark:bg-[#2f374b] border border-slate-300 dark:border-[#434e6b] text-sm font-bold text-slate-900 dark:text-[#edf1f7] active:scale-95 cursor-pointer">
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m15 18-6-6 6-6"/></svg>
            Volver
          </button>
          <button id="btn-toggle-fav" type="button" class="min-h-[46px] px-4 rounded-xl bg-white dark:bg-[#2f374b] border border-slate-300 dark:border-[#434e6b] text-sm font-bold text-slate-900 dark:text-[#edf1f7] active:scale-95 cursor-pointer">
            ${isFav ? '★ Guardada' : '☆ Guardar'}
          </button>
        </div>

        <div>
          <h2 class="text-xl font-extrabold text-slate-950 dark:text-[#edf1f7] leading-snug">${escapeHtml(stop.name)}</h2>
          <p class="mt-0.5 text-[13px] font-semibold text-slate-700 dark:text-[#b4bfd4] tabular-nums">
            ${escapeHtml(modeLabel(stop.mode))} · Parada ${escapeHtml(stop.code)}${escapeHtml(mun)}
          </p>
        </div>

        <div class="pt-2 border-t border-slate-300 dark:border-[#3c4660]">
          ${arrivalsHtml}
        </div>

        ${
          passingRoutes.length > 0
            ? `
          <div class="pt-3 border-t border-slate-300 dark:border-[#3c4660]">
            <h3 class="text-[13px] font-bold text-slate-700 dark:text-[#b4bfd4] mb-2.5">Líneas en esta parada</h3>
            <div class="flex flex-wrap gap-2">
              ${passingRoutes
                .map(
                  (r) => `
                <button type="button" data-route-key="${escapeHtml(routeKey(r))}" class="route-row min-h-[46px] inline-flex items-center gap-2.5 pr-3.5 pl-1.5 py-1.5 rounded-xl bg-white dark:bg-[#2f374b] border border-slate-300 dark:border-[#434e6b] active:scale-95 cursor-pointer">
                  ${renderLineBadge(r.id, r.color, r.textColor, r.mode)}
                  <span class="text-sm font-semibold text-slate-900 dark:text-[#edf1f7] max-w-[200px] truncate">${escapeHtml(r.name)}</span>
                </button>
              `
                )
                .join('')}
            </div>
          </div>
        `
            : ''
        }
      </div>
    `;
  };

  const renderRouteDetail = (route: Route) => {
    const routeStops = state.stops.filter(
      (s) => s.mode === route.mode && s.lines.includes(route.id)
    );

    return `
      <div class="space-y-4">
        <div class="flex items-center justify-between">
          <button id="btn-back-detail" type="button" class="min-h-[46px] px-3 -ml-1 inline-flex items-center gap-1.5 rounded-xl bg-white dark:bg-[#2f374b] border border-slate-300 dark:border-[#434e6b] text-sm font-bold text-slate-900 dark:text-[#edf1f7] active:scale-95 cursor-pointer">
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m15 18-6-6 6-6"/></svg>
            Todas las líneas
          </button>
        </div>

        <div class="flex items-center gap-3.5 p-3.5 rounded-2xl bg-white dark:bg-[#2f374b] border border-slate-300 dark:border-[#434e6b]">
          ${renderLineBadge(route.id, route.color, route.textColor, route.mode, true)}
          <div class="min-w-0">
            <h2 class="text-lg font-extrabold text-slate-950 dark:text-[#edf1f7] leading-snug">${escapeHtml(route.name)}</h2>
            <p class="text-[13px] font-semibold text-slate-700 dark:text-[#b4bfd4]">
              ${escapeHtml(modeLabel(route.mode))} · ${routeStops.length} paradas${
                state.lineVehicles.length > 0 ? ` · ${state.lineVehicles.length} buses en ruta` : ''
              }
            </p>
          </div>
        </div>

        <div class="pt-1">
          ${
            routeStops.length > 0
              ? routeStops.map((s) => renderStopRow(s)).join('')
              : `<p class="py-4 text-sm font-medium text-slate-700 dark:text-[#b4bfd4]">Consulta las paradas directamente sobre el trazado en el mapa.</p>`
          }
        </div>
      </div>
    `;
  };

  const renderPanel = () => {
    updateNavAndModeButtons();

    if (state.selectedStop) {
      panelBody.innerHTML = renderStopDetail(state.selectedStop);
      wireDynamicHandlers();
      return;
    }

    if (state.selectedRoute) {
      panelBody.innerHTML = renderRouteDetail(state.selectedRoute);
      wireDynamicHandlers();
      return;
    }

    const q = normalizeText(state.query);

    if (q.length > 0) {
      const matchedRoutes = state.routes
        .filter(
          (r) =>
            matchesMode(r.mode) &&
            (normalizeText(r.id).includes(q) || normalizeText(r.name).includes(q))
        )
        .slice(0, 12);

      const matchedStops = state.stops
        .filter(
          (s) =>
            matchesMode(s.mode) &&
            (normalizeText(s.name).includes(q) ||
              normalizeText(s.code).includes(q) ||
              (s.municipality && normalizeText(s.municipality).includes(q)))
        )
        .slice(0, 40);

      let html = '';
      if (matchedRoutes.length > 0) {
        html += `<h3 class="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-[#b4bfd4] mb-2">Líneas (${matchedRoutes.length})</h3>`;
        html += `<div class="mb-4">${matchedRoutes.map(renderRouteRow).join('')}</div>`;
      }
      if (matchedStops.length > 0) {
        html += `<h3 class="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-[#b4bfd4] mb-2">Paradas (${matchedStops.length})</h3>`;
        html += `<div>${matchedStops.map((s) => renderStopRow(s)).join('')}</div>`;
      }
      if (!html) {
        html = `<div class="py-10 text-center text-sm font-semibold text-slate-700 dark:text-[#b4bfd4]">No se encontraron líneas ni paradas en Granada para "${escapeHtml(state.query)}".</div>`;
      }
      panelBody.innerHTML = html;
      wireDynamicHandlers();
      return;
    }

    if (state.tab === 'favoritos') {
      const favStops = Array.from(state.favorites)
        .map((k) => state.stopsByKey.get(k))
        .filter((s): s is Stop => s !== undefined)
        .filter((s) => matchesMode(s.mode));

      if (favStops.length === 0) {
        panelBody.innerHTML = `
          <div class="py-12 px-4 rounded-2xl bg-white dark:bg-[#2f374b] border border-slate-300 dark:border-[#434e6b] text-center space-y-2">
            <p class="text-base font-bold text-slate-900 dark:text-[#edf1f7]">Aún no tienes paradas guardadas</p>
            <p class="text-sm text-slate-700 dark:text-[#b4bfd4] max-w-xs mx-auto">Toca cualquier parada en el mapa o en el buscador y pulsa "Guardar" para ver sus tiempos al instante.</p>
          </div>
        `;
      } else {
        panelBody.innerHTML = favStops.map((s) => renderStopRow(s)).join('');
        wireDynamicHandlers();
      }
      return;
    }

    if (state.tab === 'lineas') {
      const filteredRoutes = state.routes.filter((r) => matchesMode(r.mode));
      panelBody.innerHTML = `
        <div class="mb-2.5 text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-[#b4bfd4] tabular-nums">${filteredRoutes.length} líneas en Granada</div>
        <div>${filteredRoutes.map(renderRouteRow).join('')}</div>
      `;
      wireDynamicHandlers();
      return;
    }

    let html = '';

    // Acceso rápido a favoritas en 1 toque nada más abrir
    const quickFavs = Array.from(state.favorites)
      .map((k) => state.stopsByKey.get(k))
      .filter((s): s is Stop => s !== undefined)
      .filter((s) => matchesMode(s.mode))
      .slice(0, 4);

    if (quickFavs.length > 0) {
      html += `
        <div class="mb-3.5">
          <h3 class="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-[#b4bfd4] mb-2">Acceso rápido · Favoritas</h3>
          <div>${quickFavs.map((s) => renderStopRow(s)).join('')}</div>
        </div>
      `;
    }

    if (state.userPos) {
      const nearby = state.stops
        .filter((s) => matchesMode(s.mode))
        .map((s) => ({
          stop: s,
          dist: haversineMeters(state.userPos!.lat, state.userPos!.lon, s.lat, s.lon),
        }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 15);

      html += `
        <div class="mb-2 flex items-center justify-between">
          <h3 class="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-[#b4bfd4]">Paradas cercanas a ti</h3>
        </div>
        <div>${nearby.map((n) => renderStopRow(n.stop, n.dist)).join('')}</div>
      `;
    } else {
      const metroStops = state.stops.filter((s) => s.mode === 'metro' && matchesMode('metro'));
      const featuredUrban = state.stops
        .filter((s) => s.mode === 'urbano' && matchesMode('urbano') && s.lines.length >= 4)
        .slice(0, 12);
      const featuredCtagr = state.stops
        .filter((s) => s.mode === 'interurbano' && matchesMode('interurbano'))
        .slice(0, 10);

      html += `
        <div class="mb-4 p-3.5 rounded-2xl bg-white dark:bg-[#2f374b] border border-slate-300 dark:border-[#434e6b] flex items-center justify-between gap-3 shadow-2xs">
          <div class="min-w-0">
            <div class="text-sm font-bold text-slate-950 dark:text-[#edf1f7]">Paradas cerca de ti</div>
            <div class="text-xs font-medium text-slate-700 dark:text-[#b4bfd4]">Tiempos y distancia caminando</div>
          </div>
          <button id="btn-locate-inline" type="button" class="min-h-[46px] px-4 rounded-xl bg-slate-900 dark:bg-[#7ee0c6] text-white dark:text-[#18202c] text-sm font-bold whitespace-nowrap shrink-0 active:scale-95 cursor-pointer">
            ${state.locating ? 'Buscando...' : 'Ubicar'}
          </button>
        </div>
        ${
          state.locationError
            ? `<p class="mb-3 text-xs font-semibold text-amber-800 dark:text-[#fcd34d]">${escapeHtml(state.locationError)}</p>`
            : ''
        }
      `;

      const list = [...metroStops.slice(0, 8), ...featuredUrban, ...featuredCtagr].slice(0, 25);
      html += `
        <div class="mb-2 flex items-center justify-between text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-[#b4bfd4] tabular-nums">
          <span>Red de Granada</span>
          <span>${state.stops.filter((s) => matchesMode(s.mode)).length} paradas</span>
        </div>
        <div>${list.map((s) => renderStopRow(s)).join('')}</div>
      `;
    }

    panelBody.innerHTML = html;
    wireDynamicHandlers();
  };

  const wireDynamicHandlers = () => {
    panelBody.querySelectorAll<HTMLElement>('.stop-row').forEach((el) => {
      el.addEventListener('click', () => {
        const key = el.dataset.stopKey;
        if (!key) return;
        const stop = state.stopsByKey.get(key);
        if (stop) selectStop(stop);
      });
    });

    panelBody.querySelectorAll<HTMLElement>('.route-row').forEach((el) => {
      el.addEventListener('click', () => {
        const key = el.dataset.routeKey;
        if (!key) return;
        const route = state.routesByKey.get(key);
        if (route) selectRoute(route);
      });
    });

    document.getElementById('btn-back-detail')?.addEventListener('click', clearSelection);
    document.getElementById('btn-refresh-arrivals')?.addEventListener('click', () => {
      void refreshSelectedStopArrivals(false);
    });
    document.getElementById('btn-toggle-fav')?.addEventListener('click', () => {
      if (!state.selectedStop) return;
      const key = stopKey(state.selectedStop);
      if (state.favorites.has(key)) {
        state.favorites.delete(key);
      } else {
        state.favorites.add(key);
      }
      saveFavorites(state.favorites);
      renderPanel();
    });
    document.getElementById('btn-locate-inline')?.addEventListener('click', requestUserLocation);
  };

  const requestUserLocation = () => {
    if (!navigator.geolocation) {
      state.locationError = 'Tu navegador no soporta geolocalización.';
      renderPanel();
      return;
    }
    state.locating = true;
    state.locationError = null;
    renderPanel();

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.locating = false;
        state.userPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        state.tab = 'explorar';
        state.selectedStop = null;
        state.selectedRoute = null;
        applySheetSnap('half');
        map.setUserLocation(
          pos.coords.latitude,
          pos.coords.longitude,
          true,
          getMobileBottomClearance()
        );
        renderPanel();
      },
      () => {
        state.locating = false;
        state.locationError = 'No se pudo obtener tu ubicación. Revisa los permisos.';
        renderPanel();
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  };

  document.getElementById('brand-reset')?.addEventListener('click', (e) => {
    e.preventDefault();
    state.tab = 'explorar';
    state.query = '';
    searchInput.value = '';
    searchClear.classList.add('hidden');
    clearSelection();
    applySheetSnap('peek');
    map.resetView();
  });

  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    applyTheme(!state.darkTheme);
    renderPanel();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.nav as ActiveTab;
      if (state.tab === target && !state.selectedStop && !state.selectedRoute && isMobile()) {
        applySheetSnap(state.sheetSnap === 'peek' ? 'half' : 'peek');
        return;
      }
      state.tab = target;
      state.selectedStop = null;
      state.selectedRoute = null;
      stopAutoRefresh();
      map.setSelectedStop(null, false);
      map.setSelectedRoute(null, false);
      map.setVehicles([]);
      applySheetSnap('half');
      renderPanel();
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const clicked = btn.dataset.mode as ModeFilter;
      const nextMode: ModeFilter = clicked !== 'todos' && state.modeFilter === clicked ? 'todos' : clicked;
      state.modeFilter = nextMode;
      const visible =
        nextMode === 'todos'
          ? new Set<TransitMode>(['urbano', 'interurbano', 'metro'])
          : new Set<TransitMode>([nextMode]);
      map.setVisibleModes(visible);
      renderPanel();
    });
  });

  searchInput.addEventListener('focus', () => {
    if (isMobile() && state.sheetSnap === 'peek') {
      applySheetSnap('half');
    }
  });

  searchInput.addEventListener('input', () => {
    state.query = searchInput.value;
    searchClear.classList.toggle('hidden', state.query.length === 0);
    if (state.query.length > 0) {
      state.selectedStop = null;
      state.selectedRoute = null;
      if (isMobile() && state.sheetSnap === 'peek') {
        applySheetSnap('half');
      }
    }
    renderPanel();
  });

  searchClear.addEventListener('click', () => {
    state.query = '';
    searchInput.value = '';
    searchClear.classList.add('hidden');
    renderPanel();
    searchInput.focus();
  });

  toggleRoutesBtn.addEventListener('click', () => {
    syncGlobalRoutesButton(!state.showGlobalRoutes);
  });

  document.getElementById('btn-locate')?.addEventListener('click', requestUserLocation);
  document.getElementById('btn-zoom-in')?.addEventListener('click', () => map.zoomBy(1.1, getMobileBottomClearance()));
  document.getElementById('btn-zoom-out')?.addEventListener('click', () => map.zoomBy(-1.1, getMobileBottomClearance()));
  document.getElementById('btn-reset-view')?.addEventListener('click', () => map.resetView());

  const autoCenterIfPermitted = async () => {
    if (!navigator.geolocation || !navigator.permissions?.query) return;
    try {
      const status = await navigator.permissions.query({ name: 'geolocation' });
      if (status.state !== 'granted') return;
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          state.userPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
          if (!state.selectedStop && !state.selectedRoute) {
            map.setUserLocation(
              pos.coords.latitude,
              pos.coords.longitude,
              true,
              getMobileBottomClearance()
            );
          } else {
            map.setUserLocation(pos.coords.latitude, pos.coords.longitude, false);
          }
          renderPanel();
        },
        () => {
          // ignorar si falla en segundo plano
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 }
      );
    } catch {
      // ignorar si el navegador no soporta permissions.query
    }
  };

  applySheetSnap('peek', false);
  void autoCenterIfPermitted();

  try {
    const network = await loadNetworkData();
    state.stops = network.stops;
    state.routes = network.routes.sort((a, b) => {
      const order: Record<TransitMode, number> = { metro: 0, urbano: 1, interurbano: 2 };
      if (order[a.mode] !== order[b.mode]) return order[a.mode] - order[b.mode];
      return a.id.localeCompare(b.id, 'es', { numeric: true });
    });

    for (const s of state.stops) state.stopsByKey.set(stopKey(s), s);
    for (const r of state.routes) state.routesByKey.set(routeKey(r), r);

    map.setData(state.stops, state.routes);
    renderPanel();
  } catch {
    panelBody.innerHTML = `
      <div class="py-10 text-center text-sm font-semibold text-red-700 dark:text-[#f28b82]">
        No se pudo cargar la red de transporte. Recarga la página.
      </div>
    `;
  }
}

bootstrap();
