import type {
  ArrivalItem,
  DayBucket,
  NetworkData,
  Route,
  ScheduleData,
  ScheduleLineMap,
  Stop,
  StopArrivalsResult,
  StopScheduleBuckets,
  VehicleItem,
} from './types';

const MOVGR_DIRECT = 'https://movgr.apis.mianfg.me';
const MOVGR_PROXY_URL = (import.meta.env.VITE_MOVGR_PROXY_URL || '').trim().replace(/\/+$/, '');

let cachedNetwork: NetworkData | null = null;
let cachedSchedules: ScheduleData | null = null;

export async function loadNetworkData(): Promise<NetworkData> {
  if (cachedNetwork) return cachedNetwork;
  const res = await fetch(`${import.meta.env.BASE_URL}data/network.json`);
  if (!res.ok) {
    throw new Error('No se pudo cargar el archivo de red de Granada');
  }
  const data = (await res.json()) as NetworkData;
  cachedNetwork = data;
  return data;
}

async function loadSchedules(): Promise<ScheduleData> {
  if (cachedSchedules) return cachedSchedules;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/schedules.json`);
    if (!res.ok) return {};
    cachedSchedules = (await res.json()) as ScheduleData;
    return cachedSchedules;
  } catch {
    return {};
  }
}

async function fetchMovgrJson<T>(apiPath: string): Promise<T> {
  // 1. Si hay un Worker/proxy propio configurado (p. ej. Cloudflare Worker para GitHub Pages), usarlo directamente
  if (MOVGR_PROXY_URL) {
    const workerRes = await fetch(`${MOVGR_PROXY_URL}${apiPath}`, {
      signal: AbortSignal.timeout(7000),
    });
    if (!workerRes.ok) {
      throw new Error(`HTTP ${workerRes.status}`);
    }
    return (await workerRes.json()) as T;
  }

  // 2. En entornos con servidor Node/Express (desarrollo o VPS), probar proxy local /api/movgr/*
  const isGitHubPages = typeof window !== 'undefined' && window.location.hostname.endsWith('.github.io');
  if (!isGitHubPages) {
    try {
      const proxyRes = await fetch(`/api/movgr${apiPath}`, {
        signal: AbortSignal.timeout(7000),
      });
      if (proxyRes.ok) {
        return (await proxyRes.json()) as T;
      }
      if (proxyRes.status !== 404) {
        throw new Error(`HTTP ${proxyRes.status}`);
      }
    } catch (err) {
      if (err instanceof TypeError || (err instanceof Error && err.message === 'HTTP 404')) {
        // continuar al intento directo
      } else if (!navigator.onLine) {
        throw err;
      }
    }
  }

  // 3. Fallback directo a MovGR API
  const directRes = await fetch(`${MOVGR_DIRECT}${apiPath}`, {
    signal: AbortSignal.timeout(7000),
  });
  if (!directRes.ok) {
    throw new Error(`HTTP ${directRes.status}`);
  }
  return (await directRes.json()) as T;
}

function getCurrentDayInfo(now: Date): { bucket: Exclude<DayBucket, 'all'>; label: string } {
  const dow = now.getDay();
  if (dow === 0) return { bucket: 'su', label: 'Domingo / Festivo' };
  if (dow === 6) return { bucket: 'sa', label: 'Sábado' };
  return { bucket: 'wd', label: 'Laborables (L-V)' };
}

function isBucketedSchedule(entry: StopScheduleBuckets | ScheduleLineMap): entry is StopScheduleBuckets {
  const firstVal = Object.values(entry)[0];
  return firstVal !== undefined && !Array.isArray(firstVal);
}

function getGtfsScheduledArrivals(
  stop: Stop,
  schedules: ScheduleData,
  routesById: Map<string, Route>
): { items: ArrivalItem[]; dayLabel: string; hasGtfsData: boolean } {
  const hasGtfsData = Object.keys(schedules).length > 0;
  const now = new Date();
  const { bucket: todayBucket, label: dayLabel } = getCurrentDayInfo(now);

  const stopEntry = schedules[`${stop.mode}:${stop.id}`] ?? schedules[stop.id];
  if (!stopEntry) {
    return { items: [], dayLabel, hasGtfsData };
  }

  const activeLineMaps: ScheduleLineMap[] = [];
  if (isBucketedSchedule(stopEntry)) {
    const hasWeekdaySpecific = Boolean(stopEntry.wd || stopEntry.sa || stopEntry.su);
    if (hasWeekdaySpecific) {
      if (stopEntry[todayBucket]) activeLineMaps.push(stopEntry[todayBucket]!);
      if (stopEntry.all) activeLineMaps.push(stopEntry.all);
    } else if (stopEntry.all) {
      activeLineMaps.push(stopEntry.all);
    }
  } else {
    activeLineMaps.push(stopEntry);
  }

  if (activeLineMaps.length === 0) {
    return { items: [], dayLabel, hasGtfsData };
  }

  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const items: ArrivalItem[] = [];
  const seen = new Set<string>();

  for (const lineMap of activeLineMaps) {
    for (const [key, times] of Object.entries(lineMap)) {
      const sepIdx = key.indexOf('|');
      const lineId = sepIdx >= 0 ? key.slice(0, sepIdx) : key;
      const destination = sepIdx >= 0 ? key.slice(sepIdx + 1) : '';
      const route = routesById.get(`${stop.mode}:${lineId}`);

      for (const t of times) {
        const candidates: number[] = [t - nowMinutes];
        if (t >= 1440 && nowMinutes < 300) {
          candidates.push(t - 1440 - nowMinutes);
        } else if (nowMinutes >= 1320) {
          candidates.push(t + 1440 - nowMinutes);
        }

        for (const diff of candidates) {
          if (diff < 0 || diff > 180) continue;
          const hh = String(Math.floor((t % 1440) / 60)).padStart(2, '0');
          const mm = String(t % 60).padStart(2, '0');
          const timeText = `${hh}:${mm}`;
          const dedupKey = `${lineId}|${destination}|${timeText}|${diff}`;
          if (seen.has(dedupKey)) continue;
          seen.add(dedupKey);

          items.push({
            lineId,
            lineName: route?.name,
            color: route?.color || (stop.mode === 'metro' ? '059669' : stop.mode === 'urbano' ? 'DC2626' : '2563EB'),
            textColor: route?.textColor || 'FFFFFF',
            destination: destination || route?.name || `Línea ${lineId}`,
            minutes: diff,
            timeText,
          });
        }
      }
    }
  }

  return {
    items: items.sort((a, b) => a.minutes - b.minutes).slice(0, 12),
    dayLabel,
    hasGtfsData,
  };
}

interface RawBusArrivalResponse {
  proximos?: Array<{
    linea: { id: string; nombre?: string | null; color?: string | null; text_color?: string | null };
    destino: string;
    minutos: number;
  }>;
}

interface RawCtagrArrivalResponse {
  proximos?: Array<{
    linea: { id: string; nombre?: string | null; color?: string | null; text_color?: string | null };
    destino: string;
    hora: string;
    minutos: number;
    en_ruta?: boolean;
  }>;
  vehiculos?: Array<{
    linea: string;
    sentido: number;
    lat: number | null;
    lon: number | null;
    visto?: string | null;
  }>;
}

interface RawMetroArrivalResponse {
  proximos?: Array<{
    direccion: string;
    minutos: number;
  }>;
}

function resolveMovgrStopId(stop: Stop): string | null {
  if (stop.apiId) {
    if (stop.mode === 'urbano') {
      const m = /^\s*0*(\d+)\s*$/.exec(stop.apiId);
      return m ? m[1] : null;
    }
    if (stop.mode === 'interurbano') {
      return stop.apiId.trim().replace(/^\d+_/, '');
    }
    return stop.apiId;
  }

  const idTrim = stop.id.trim();
  const codeTrim = stop.code.trim();

  if (stop.mode === 'urbano') {
    if (/^\d+$/.test(idTrim)) return String(Number(idTrim));
    if (/^\d+$/.test(codeTrim)) return String(Number(codeTrim));
    const codeDigits = /^0*(\d+)$/.exec(codeTrim);
    return codeDigits ? codeDigits[1] : null;
  }

  if (stop.mode === 'metro') {
    if (/^\d+$/.test(idTrim)) return idTrim;
    const mCode = /^M(\d+)$/i.exec(codeTrim);
    if (mCode) return mCode[1];
    if (/^\d+$/.test(codeTrim)) return codeTrim;
    return idTrim;
  }

  // interurbano (ej: GTFS Junta usa "3_14628", MovGR API espera "14628")
  if (/^\d+$/.test(idTrim)) return idTrim;
  const prefixedId = /^\d+_(\d+)$/.exec(idTrim);
  if (prefixedId) return prefixedId[1];
  if (/^\d+$/.test(codeTrim)) return codeTrim;
  const prefixedCode = /^\d+_(\d+)$/.exec(codeTrim);
  if (prefixedCode) return prefixedCode[1];
  return idTrim.replace(/^\d+_/, '');
}

export async function fetchStopArrivals(
  stop: Stop,
  routesById: Map<string, Route>
): Promise<StopArrivalsResult> {
  const apiStopId = resolveMovgrStopId(stop);

  if (navigator.onLine && apiStopId) {
    try {
      let liveArrivals: ArrivalItem[] = [];
      let vehicles: VehicleItem[] = [];

      if (stop.mode === 'urbano') {
        const data = await fetchMovgrJson<RawBusArrivalResponse>(`/bus/llegadas/${encodeURIComponent(apiStopId)}`);
        liveArrivals = (data.proximos || []).map((p) => {
          const fallbackRoute = routesById.get(`urbano:${p.linea.id}`);
          return {
            lineId: String(p.linea.id),
            lineName: p.linea.nombre || fallbackRoute?.name,
            color: (p.linea.color || fallbackRoute?.color || 'DC2626').replace('#', ''),
            textColor: (p.linea.text_color || fallbackRoute?.textColor || 'FFFFFF').replace('#', ''),
            destination: p.destino,
            minutes: p.minutos,
          };
        });
      } else if (stop.mode === 'interurbano') {
        const data = await fetchMovgrJson<RawCtagrArrivalResponse>(`/ctagr/llegadas/${encodeURIComponent(apiStopId)}`);
        liveArrivals = (data.proximos || []).map((p) => {
          const fallbackRoute = routesById.get(`interurbano:${p.linea.id}`);
          const rawColor = p.linea.color && p.linea.color !== 'FFFFFF' ? p.linea.color : fallbackRoute?.color || '2563EB';
          return {
            lineId: String(p.linea.id),
            lineName: p.linea.nombre || fallbackRoute?.name,
            color: rawColor.replace('#', ''),
            textColor: 'FFFFFF',
            destination: p.destino,
            minutes: p.minutos,
            timeText: p.hora,
            inRoute: p.en_ruta,
          };
        });
        vehicles = (data.vehiculos || [])
          .filter((v) => v.lat !== null && v.lon !== null)
          .map((v) => ({
            lineId: String(v.linea),
            direction: v.sentido,
            lat: v.lat as number,
            lon: v.lon as number,
            seenAt: v.visto,
          }));
      } else if (stop.mode === 'metro') {
        const data = await fetchMovgrJson<RawMetroArrivalResponse>(`/metro/llegadas/${encodeURIComponent(apiStopId)}`);
        liveArrivals = (data.proximos || []).map((p) => ({
          lineId: '1',
          lineName: 'Metro de Granada',
          color: '059669',
          textColor: 'FFFFFF',
          destination: `Dirección ${p.direccion}`,
          minutes: p.minutos,
        }));
      }

      return {
        source: 'realtime',
        arrivals: liveArrivals,
        gtfsArrivals: [],
        vehicles,
      };
    } catch (err) {
      const schedules = await loadSchedules();
      const { items: gtfsArrivals, dayLabel: gtfsDayLabel, hasGtfsData } = getGtfsScheduledArrivals(
        stop,
        schedules,
        routesById
      );
      if (gtfsArrivals.length > 0) {
        return {
          source: 'gtfs',
          arrivals: gtfsArrivals,
          gtfsArrivals,
          gtfsDayLabel,
          hasGtfsData,
          vehicles: [],
          error: 'Online no disponible · Mostrando horario Offline',
        };
      }
      return {
        source: 'unavailable',
        arrivals: [],
        gtfsArrivals: [],
        gtfsDayLabel,
        hasGtfsData,
        vehicles: [],
        error: err instanceof Error && err.message.startsWith('HTTP') ? 'Servicio Online temporalmente no disponible' : 'Servicio Online temporalmente no disponible',
      };
    }
  }

  const schedules = await loadSchedules();
  const { items: gtfsArrivals, dayLabel: gtfsDayLabel, hasGtfsData } = getGtfsScheduledArrivals(
    stop,
    schedules,
    routesById
  );
  if (gtfsArrivals.length > 0) {
    return {
      source: 'gtfs',
      arrivals: gtfsArrivals,
      gtfsArrivals,
      gtfsDayLabel,
      hasGtfsData,
      vehicles: [],
      error: !navigator.onLine
        ? 'Offline · Horario guardado'
        : 'Offline · Horario programado de parada',
    };
  }
  return {
    source: 'unavailable',
    arrivals: [],
    gtfsArrivals: [],
    gtfsDayLabel,
    hasGtfsData,
    vehicles: [],
    error: !navigator.onLine
      ? 'Offline · No hay horarios guardados para esta parada'
      : 'Sin horarios Online ni Offline disponibles para esta parada',
  };
}

interface RawCtagrLineDetail {
  vehiculos?: Array<{
    linea: string;
    sentido: number;
    lat: number | null;
    lon: number | null;
    visto?: string | null;
  }>;
}

export async function fetchLineVehicles(route: Route): Promise<VehicleItem[]> {
  if (route.mode !== 'interurbano' || !navigator.onLine) return [];
  try {
    const data = await fetchMovgrJson<RawCtagrLineDetail>(`/ctagr/lineas/${encodeURIComponent(route.id)}`);
    return (data.vehiculos || [])
      .filter((v) => v.lat !== null && v.lon !== null)
      .map((v) => ({
        lineId: String(v.linea),
        direction: v.sentido,
        lat: v.lat as number,
        lon: v.lon as number,
        seenAt: v.visto,
      }));
  } catch {
    return [];
  }
}
