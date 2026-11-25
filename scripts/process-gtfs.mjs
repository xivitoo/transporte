/**
 * Procesador automático de GTFS para Granada (Bus Urbano, Interurbano Junta/CTAGR, Metro)
 * - Cero dependencias externas (Node.js nativo + zlib)
 * - Soporta carpetas con archivos .txt o archivos .zip en:
 *     gtfs/urbano/
 *     gtfs/interurbano/
 *     gtfs/metro/
 * - Filtra automáticamente SOLO Granada dentro del GTFS completo de Andalucía (Junta)
 * - Genera JSON optimizado y compacto en public/data/network.json y public/data/schedules.json
 * - Modo --sync-api: sincroniza datos reales iniciales desde https://movgr.apis.mianfg.me/
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = process.cwd();
const GTFS_DIR = path.join(ROOT, 'gtfs');
const OUT_DIR = path.join(ROOT, 'public', 'data');

// Bounding box geográfico estricto de la provincia y área metropolitana de Granada
const GRANADA_BOUNDS = {
  minLat: 36.68,
  maxLat: 37.75,
  minLon: -4.40,
  maxLon: -2.42,
};

// Consorcios / agencias de otras provincias andaluzas que deben excluirse si aparecen en el feed conjunto
const EXCLUDED_AGENCIES_REGEX = /(sevilla|m[aá]laga|c[oó]rdoba|ja[eé]n|almer[ií]a|c[aá]diz|huelva|campo de gibraltar|bah[ií]a de c[aá]diz|costa del sol)/i;
const GRANADA_AGENCIES_REGEX = /(granada|ctagr|rober|metro de granada|alsa.*granada|area metropolitana.*granada)/i;

function isPointInGranada(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return (
    lat >= GRANADA_BOUNDS.minLat &&
    lat <= GRANADA_BOUNDS.maxLat &&
    lon >= GRANADA_BOUNDS.minLon &&
    lon <= GRANADA_BOUNDS.maxLon
  );
}

// --- Lector ZIP nativo sin dependencias externas ---
function extractZipEntries(zipBuffer) {
  const entries = new Map();
  // Buscar End of Central Directory (0x06054b50)
  let eocdOffset = -1;
  for (let i = zipBuffer.length - 22; i >= Math.max(0, zipBuffer.length - 65558); i--) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('Archivo ZIP inválido (sin EOCD)');

  const cdEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  let offset = zipBuffer.readUInt32LE(eocdOffset + 16);

  for (let i = 0; i < cdEntries; i++) {
    if (zipBuffer.readUInt32LE(offset) !== 0x02014b50) break;
    const compression = zipBuffer.readUInt16LE(offset + 10);
    const compSize = zipBuffer.readUInt32LE(offset + 20);
    const nameLen = zipBuffer.readUInt16LE(offset + 28);
    const extraLen = zipBuffer.readUInt16LE(offset + 30);
    const commentLen = zipBuffer.readUInt16LE(offset + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(offset + 42);
    const fileName = zipBuffer.toString('utf8', offset + 46, offset + 46 + nameLen);
    offset += 46 + nameLen + extraLen + commentLen;

    if (fileName.endsWith('/')) continue;
    const baseName = path.basename(fileName).toLowerCase();
    if (!baseName.endsWith('.txt')) continue;

    const lfhNameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26);
    const lfhExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
    const compressedSlice = zipBuffer.subarray(dataStart, dataStart + compSize);

    let contentBuf;
    if (compression === 0) {
      contentBuf = compressedSlice;
    } else if (compression === 8) {
      contentBuf = zlib.inflateRawSync(compressedSlice);
    } else {
      continue;
    }
    entries.set(baseName, contentBuf.toString('utf8'));
  }
  return entries;
}

function loadGtfsSourceFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return null;
  const items = fs.readdirSync(dirPath);
  const txtFiles = items.filter((f) => f.toLowerCase().endsWith('.txt'));
  if (txtFiles.length > 0) {
    const map = new Map();
    for (const f of txtFiles) {
      map.set(f.toLowerCase(), fs.readFileSync(path.join(dirPath, f), 'utf8'));
    }
    return map;
  }
  const zipFile = items.find((f) => f.toLowerCase().endsWith('.zip'));
  if (zipFile) {
    console.log(`  Descomprimiendo ${zipFile}...`);
    return extractZipEntries(fs.readFileSync(path.join(dirPath, zipFile)));
  }
  return null;
}

// --- Parser CSV rápido compatible con comillas RFC 4180 ---
function parseCsvLines(text, onRow) {
  if (!text) return;
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = clean.split(/\r?\n/);
  if (lines.length < 2) return;
  const headers = splitCsvRow(lines[0]).map((h) => h.trim());
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const cols = splitCsvRow(line);
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = cols[j] !== undefined ? cols[j].trim() : '';
    }
    onRow(row);
  }
}

function splitCsvRow(line) {
  if (!line.includes('"')) return line.split(',');
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// --- Simplificación Douglas-Peucker para reducir tamaño de polilíneas ---
function perpendicularDist(pt, lineStart, lineEnd) {
  const dx = lineEnd[0] - lineStart[0];
  const dy = lineEnd[1] - lineStart[1];
  if (dx === 0 && dy === 0) return Math.hypot(pt[0] - lineStart[0], pt[1] - lineStart[1]);
  const t = ((pt[0] - lineStart[0]) * dx + (pt[1] - lineStart[1]) * dy) / (dx * dx + dy * dy);
  const projX = lineStart[0] + t * dx;
  const projY = lineStart[1] + t * dy;
  return Math.hypot(pt[0] - projX, pt[1] - projY);
}

function simplifyPath(points, epsilon = 0.00018) {
  if (points.length <= 2) return points;
  let maxDist = 0;
  let idx = 0;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDist(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      idx = i;
    }
  }
  if (maxDist > epsilon) {
    const left = simplifyPath(points.slice(0, idx + 1), epsilon);
    const right = simplifyPath(points.slice(idx), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

function roundCoord(n) {
  return Math.round(n * 100000) / 100000;
}

function timeToMinutes(hhmmss) {
  if (!hhmmss) return null;
  const parts = hhmmss.split(':');
  if (parts.length < 2) return null;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function parseGtfsDateDayBucket(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length !== 8) return null;
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6));
  const d = Number(yyyymmdd.slice(6, 8));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();
  if (dow === 0) return 'su';
  if (dow === 6) return 'sa';
  return 'wd';
}

function parseServiceDayBuckets(files) {
  const bucketsByService = new Map();
  const hasCalendar = files.has('calendar.txt') || files.has('calendar_dates.txt');

  const addBucket = (serviceId, bucket) => {
    if (!serviceId) return;
    if (!bucketsByService.has(serviceId)) bucketsByService.set(serviceId, new Set());
    bucketsByService.get(serviceId).add(bucket);
  };

  if (files.has('calendar.txt')) {
    parseCsvLines(files.get('calendar.txt'), (row) => {
      const id = row.service_id;
      if (!id) return;
      if (
        row.monday === '1' ||
        row.tuesday === '1' ||
        row.wednesday === '1' ||
        row.thursday === '1' ||
        row.friday === '1'
      ) {
        addBucket(id, 'wd');
      }
      if (row.saturday === '1') addBucket(id, 'sa');
      if (row.sunday === '1') addBucket(id, 'su');
    });
  }

  if (files.has('calendar_dates.txt')) {
    parseCsvLines(files.get('calendar_dates.txt'), (row) => {
      const id = row.service_id;
      if (!id || row.exception_type !== '1') return;
      const bucket = parseGtfsDateDayBucket(row.date);
      if (bucket) addBucket(id, bucket);
    });
  }

  return { hasCalendar, bucketsByService };
}

function processGtfsMode(mode, files) {
  console.log(`Procesando GTFS local [${mode}]...`);
  const validAgencyIds = new Set();
  const excludedAgencyIds = new Set();

  if (files.has('agency.txt')) {
    parseCsvLines(files.get('agency.txt'), (row) => {
      const id = row.agency_id || 'default';
      const name = `${row.agency_name || ''} ${row.agency_url || ''}`;
      if (EXCLUDED_AGENCIES_REGEX.test(name) && !GRANADA_AGENCIES_REGEX.test(name)) {
        excludedAgencyIds.add(id);
      } else {
        validAgencyIds.add(id);
      }
    });
  }

  const { hasCalendar, bucketsByService } = parseServiceDayBuckets(files);

  // 1. Paradas filtradas geográficamente a Granada
  const granadaStops = new Map();
  parseCsvLines(files.get('stops.txt'), (row) => {
    const lat = Number(row.stop_lat);
    const lon = Number(row.stop_lon);
    if (!isPointInGranada(lat, lon)) return;
    granadaStops.set(row.stop_id, {
      id: row.stop_id,
      code: row.stop_code || row.stop_id,
      name: row.stop_name || row.stop_id,
      lat: roundCoord(lat),
      lon: roundCoord(lon),
      mode,
      lines: new Set(),
    });
  });

  // 2. Rutas candidatas (excluye agencias de otras provincias andaluzas)
  const candidateRoutes = new Map();
  parseCsvLines(files.get('routes.txt'), (row) => {
    const agencyId = row.agency_id || 'default';
    if (excludedAgencyIds.has(agencyId)) return;
    const shortName = (row.route_short_name || row.route_id || '').trim();
    const longName = (row.route_long_name || '').trim();
    if (EXCLUDED_AGENCIES_REGEX.test(longName) && !/granada/i.test(longName)) return;
    candidateRoutes.set(row.route_id, {
      id: shortName || row.route_id,
      gtfsRouteId: row.route_id,
      name: longName || shortName || row.route_id,
      color: (row.route_color || (mode === 'metro' ? '059669' : mode === 'urbano' ? 'DC2626' : '2563EB')).replace('#', ''),
      textColor: (row.route_text_color || 'FFFFFF').replace('#', ''),
      mode,
    });
  });

  // 3. Trips pertenecientes a rutas candidatas
  const candidateTrips = new Map();
  parseCsvLines(files.get('trips.txt'), (row) => {
    if (!candidateRoutes.has(row.route_id)) return;
    candidateTrips.set(row.trip_id, {
      tripId: row.trip_id,
      routeId: row.route_id,
      serviceId: row.service_id,
      direction: Number(row.direction_id || 0),
      headsign: row.trip_headsign || '',
      shapeId: row.shape_id || '',
    });
  });

  // 4. Stop times: detectar qué trips tocan paradas de Granada y construir horarios teóricos por tipo de día
  const usedTripIds = new Set();
  const usedShapeIds = new Set();
  const usedRouteIds = new Set();
  const usedStopIds = new Set();
  // scheduleMap: `${mode}:${stopId}` -> Map<dayBucket, Map<lineKey, Set<minutes>>>
  const scheduleByStop = new Map();

  parseCsvLines(files.get('stop_times.txt'), (row) => {
    const trip = candidateTrips.get(row.trip_id);
    if (!trip) return;
    if (!granadaStops.has(row.stop_id)) return;

    usedTripIds.add(trip.tripId);
    usedRouteIds.add(trip.routeId);
    usedStopIds.add(row.stop_id);
    if (trip.shapeId) usedShapeIds.add(trip.shapeId);

    const route = candidateRoutes.get(trip.routeId);
    const stop = granadaStops.get(row.stop_id);
    stop.lines.add(route.id);

    const mins = timeToMinutes(row.departure_time || row.arrival_time);
    if (mins !== null) {
      const stopKey = `${mode}:${row.stop_id}`;
      if (!scheduleByStop.has(stopKey)) scheduleByStop.set(stopKey, new Map());
      const bucketMap = scheduleByStop.get(stopKey);

      const matchedBuckets =
        hasCalendar && trip.serviceId && bucketsByService.has(trip.serviceId)
          ? Array.from(bucketsByService.get(trip.serviceId))
          : ['all'];
      const lineKey = `${route.id}|${trip.headsign || route.name}`;

      for (const bucket of matchedBuckets) {
        if (!bucketMap.has(bucket)) bucketMap.set(bucket, new Map());
        const lineMap = bucketMap.get(bucket);
        if (!lineMap.has(lineKey)) lineMap.set(lineKey, new Set());
        lineMap.get(lineKey).add(mins);
      }
    }
  });

  // 5. Shapes solo de los recorridos en Granada
  const rawShapes = new Map();
  if (files.has('shapes.txt')) {
    parseCsvLines(files.get('shapes.txt'), (row) => {
      if (!usedShapeIds.has(row.shape_id)) return;
      const lat = Number(row.shape_pt_lat);
      const lon = Number(row.shape_pt_lon);
      if (!isPointInGranada(lat, lon)) return;
      const seq = Number(row.shape_pt_sequence || 0);
      if (!rawShapes.has(row.shape_id)) rawShapes.set(row.shape_id, []);
      rawShapes.get(row.shape_id).push({ seq, lat, lon });
    });
  }

  // Vincular una shape por dirección a cada ruta
  const routeShapes = new Map();
  for (const tripId of usedTripIds) {
    const trip = candidateTrips.get(tripId);
    if (!trip.shapeId || !rawShapes.has(trip.shapeId)) continue;
    if (!routeShapes.has(trip.routeId)) routeShapes.set(trip.routeId, new Map());
    const dirMap = routeShapes.get(trip.routeId);
    if (!dirMap.has(trip.direction)) {
      dirMap.set(trip.direction, trip.shapeId);
    }
  }

  const routes = [];
  for (const routeId of usedRouteIds) {
    const r = candidateRoutes.get(routeId);
    const dirMap = routeShapes.get(routeId);
    const shapes = [];
    if (dirMap) {
      for (const [direction, shapeId] of dirMap.entries()) {
        const pts = (rawShapes.get(shapeId) || [])
          .sort((a, b) => a.seq - b.seq)
          .map((p) => [roundCoord(p.lat), roundCoord(p.lon)]);
        const simplified = simplifyPath(pts).map(([lat, lon]) => [roundCoord(lat), roundCoord(lon)]);
        if (simplified.length > 1) {
          shapes.push({ direction, points: simplified });
        }
      }
    }
    routes.push({
      id: r.id,
      name: r.name,
      color: r.color,
      textColor: r.textColor,
      mode,
      shapes,
    });
  }

  const stops = [];
  for (const stopId of usedStopIds) {
    const s = granadaStops.get(stopId);
    stops.push({
      id: s.id,
      code: s.code,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      mode,
      lines: Array.from(s.lines),
    });
  }

  const schedules = {};
  for (const [stopKey, bucketMap] of scheduleByStop.entries()) {
    schedules[stopKey] = {};
    for (const [bucket, lineMap] of bucketMap.entries()) {
      schedules[stopKey][bucket] = {};
      for (const [key, minsSet] of lineMap.entries()) {
        schedules[stopKey][bucket][key] = Array.from(minsSet).sort((a, b) => a - b);
      }
    }
  }

  console.log(`  -> [${mode}] ${stops.length} paradas en Granada, ${routes.length} líneas.`);
  return { stops, routes, schedules };
}

// --- Sincronización desde API MovGR para tener datos reales de Granada desde el primer momento ---
async function syncFromMovGrApi() {
  const BASE = 'https://movgr.apis.mianfg.me';
  console.log('Sincronizando red completa de Granada desde MovGR API...');

  const fetchJson = async (endpoint) => {
    const res = await fetch(`${BASE}${endpoint}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} en ${endpoint}`);
    return res.json();
  };

  const [busStopsRaw, busLinesRaw, ctagrStopsRaw, ctagrLinesRaw, metroStopsRaw, metroLineRaw] = await Promise.all([
    fetchJson('/bus/paradas'),
    fetchJson('/bus/lineas'),
    fetchJson('/ctagr/paradas'),
    fetchJson('/ctagr/lineas'),
    fetchJson('/metro/paradas'),
    fetchJson('/metro/lineas'),
  ]);

  const mapPool = async (items, concurrency, fn) => {
    const results = new Array(items.length);
    let idx = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (idx < items.length) {
        const cur = idx++;
        results[cur] = await fn(items[cur], cur);
      }
    });
    await Promise.all(workers);
    return results;
  };

  console.log(`Descargando trazados de ${busLinesRaw.length} líneas urbanas y ${ctagrLinesRaw.length} líneas CTAGR...`);

  const busDetails = await mapPool(busLinesRaw, 8, async (line) => {
    try {
      return await fetchJson(`/bus/lineas/${encodeURIComponent(line.id)}`);
    } catch {
      return { ...line, shapes: [] };
    }
  });

  const ctagrDetails = await mapPool(ctagrLinesRaw, 8, async (line) => {
    try {
      return await fetchJson(`/ctagr/lineas/${encodeURIComponent(line.id)}`);
    } catch {
      return { ...line, shapes: [] };
    }
  });

  const convertShapes = (shapes = []) =>
    shapes
      .map((sh) => ({
        direction: sh.direction ?? 0,
        points: simplifyPath(
          (sh.points || []).map((p) => [roundCoord(p.lat), roundCoord(p.lon)]),
          0.00016
        ).map(([lat, lon]) => [roundCoord(lat), roundCoord(lon)]),
      }))
      .filter((sh) => sh.points.length > 1);

  const routes = [
    {
      id: String(metroLineRaw.id || '1'),
      name: metroLineRaw.nombre || 'Albolote - Armilla',
      color: '059669',
      textColor: 'FFFFFF',
      mode: 'metro',
      shapes: convertShapes(metroLineRaw.shapes || []),
    },
    ...busDetails.map((l) => ({
      id: String(l.id),
      name: l.nombre || `Línea ${l.id}`,
      color: (l.color || 'DC2626').replace('#', ''),
      textColor: (l.text_color || 'FFFFFF').replace('#', ''),
      mode: 'urbano',
      shapes: convertShapes(l.shapes || []),
    })),
    ...ctagrDetails.map((l) => ({
      id: String(l.id),
      name: l.nombre || `Línea ${l.id}`,
      color: l.color && l.color !== 'FFFFFF' ? l.color.replace('#', '') : '2563EB',
      textColor: 'FFFFFF',
      mode: 'interurbano',
      shapes: convertShapes(l.shapes || []),
    })),
  ];

  const stops = [
    ...metroStopsRaw
      .filter((s) => isPointInGranada(Number(s.lat), Number(s.lon)))
      .map((s) => ({
        id: String(s.id),
        code: `M${s.id}`,
        name: String(s.nombre || '').trim(),
        lat: roundCoord(Number(s.lat)),
        lon: roundCoord(Number(s.lon)),
        mode: 'metro',
        lines: ['1'],
      })),
    ...busStopsRaw
      .filter((s) => isPointInGranada(Number(s.lat), Number(s.lon)))
      .map((s) => ({
        id: String(s.id),
        code: String(s.id),
        name: String(s.nombre || '').trim(),
        lat: roundCoord(Number(s.lat)),
        lon: roundCoord(Number(s.lon)),
        mode: 'urbano',
        lines: Array.isArray(s.lineas) ? s.lineas.map(String) : [],
      })),
    ...ctagrStopsRaw
      .filter((s) => isPointInGranada(Number(s.lat), Number(s.lon)))
      .map((s) => ({
        id: String(s.id),
        code: String(s.id),
        name: String(s.nombre || '').trim(),
        municipality: s.municipio || s.nucleo || null,
        lat: roundCoord(Number(s.lat)),
        lon: roundCoord(Number(s.lon)),
        mode: 'interurbano',
        lines: Array.isArray(s.lineas) ? s.lineas.map(String) : [],
      })),
  ];

  return {
    generatedAt: new Date().toISOString(),
    source: 'movgr-api',
    stops,
    routes,
  };
}

function normStopName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function approxDistMeters(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * 111320;
  const dLon = (lon2 - lon1) * 111320 * Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

async function attachMovgrApiIds(stops) {
  const endpoints = {
    urbano: 'https://movgr.apis.mianfg.me/bus/paradas',
    interurbano: 'https://movgr.apis.mianfg.me/ctagr/paradas',
    metro: 'https://movgr.apis.mianfg.me/metro/paradas',
  };

  for (const [mode, url] of Object.entries(endpoints)) {
    const modeStops = stops.filter((s) => s.mode === mode);
    if (modeStops.length === 0) continue;

    let apiStops;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      apiStops = await res.json();
    } catch {
      continue;
    }

    const byExactId = new Map();
    for (const a of apiStops) {
      byExactId.set(String(a.id).trim(), String(a.id).trim());
    }

    let matched = 0;
    for (const s of modeStops) {
      const code = String(s.code || '').trim();
      const id = String(s.id || '').trim();
      const strippedId = id.replace(/^\d+_/, '');
      const strippedCode = code.replace(/^\d+_/, '');
      const numericCode = /^\d+$/.test(code) ? String(Number(code)) : '';
      const numericId = /^\d+$/.test(id) ? String(Number(id)) : '';

      let resolved =
        byExactId.get(id) ||
        byExactId.get(code) ||
        (strippedId && byExactId.get(strippedId)) ||
        (strippedCode && byExactId.get(strippedCode)) ||
        (numericId && byExactId.get(numericId)) ||
        (numericCode && byExactId.get(numericCode)) ||
        null;

      if (!resolved) {
        const sNorm = normStopName(s.name);
        let bestId = null;
        let bestScore = Infinity;
        for (const a of apiStops) {
          const lat = Number(a.lat);
          const lon = Number(a.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
          const dist = approxDistMeters(s.lat, s.lon, lat, lon);
          if (dist > 110) continue;
          const aNorm = normStopName(a.nombre);
          const sameName = sNorm && aNorm && (sNorm === aNorm || sNorm.includes(aNorm) || aNorm.includes(sNorm));
          const score = sameName ? dist * 0.2 : dist;
          if (score < bestScore) {
            bestScore = score;
            bestId = String(a.id).trim();
          }
        }
        resolved = bestId;
      }

      if (resolved && resolved !== s.id) {
        s.apiId = resolved;
        matched++;
      }
    }
    console.log(`  -> [${mode}] Enlazadas ${matched} paradas GTFS con su ID oficial en MovGR API.`);
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const forceSyncApi = process.argv.includes('--sync-api');

  const modes = ['urbano', 'interurbano', 'metro'];
  const loadedFromGtfs = {};
  let hasAnyLocalGtfs = false;

  if (!forceSyncApi) {
    for (const mode of modes) {
      const files = loadGtfsSourceFiles(path.join(GTFS_DIR, mode));
      if (files && files.has('stops.txt') && files.has('routes.txt') && files.has('stop_times.txt')) {
        loadedFromGtfs[mode] = processGtfsMode(mode, files);
        hasAnyLocalGtfs = true;
      }
    }
  }

  if (hasAnyLocalGtfs) {
    // Mezclar modos disponibles de GTFS local con network.json y schedules.json existentes para los modos que no tengan GTFS local todavía
    const existingNetworkPath = path.join(OUT_DIR, 'network.json');
    const existingNetwork = fs.existsSync(existingNetworkPath)
      ? JSON.parse(fs.readFileSync(existingNetworkPath, 'utf8'))
      : { stops: [], routes: [] };

    const existingSchedulesPath = path.join(OUT_DIR, 'schedules.json');
    const existingSchedules = fs.existsSync(existingSchedulesPath)
      ? JSON.parse(fs.readFileSync(existingSchedulesPath, 'utf8'))
      : {};

    const allStops = [];
    const allRoutes = [];
    const allSchedules = {};

    for (const mode of modes) {
      if (loadedFromGtfs[mode]) {
        allStops.push(...loadedFromGtfs[mode].stops);
        allRoutes.push(...loadedFromGtfs[mode].routes);
        Object.assign(allSchedules, loadedFromGtfs[mode].schedules);
      } else {
        allStops.push(...existingNetwork.stops.filter((s) => s.mode === mode));
        allRoutes.push(...existingNetwork.routes.filter((r) => r.mode === mode));
        const prefix = `${mode}:`;
        for (const [k, v] of Object.entries(existingSchedules)) {
          if (k.startsWith(prefix)) allSchedules[k] = v;
        }
      }
    }

    await attachMovgrApiIds(allStops);

    const networkPayload = {
      generatedAt: new Date().toISOString(),
      source: 'gtfs-granada',
      stops: allStops,
      routes: allRoutes,
    };

    fs.writeFileSync(path.join(OUT_DIR, 'network.json'), JSON.stringify(networkPayload));
    fs.writeFileSync(path.join(OUT_DIR, 'schedules.json'), JSON.stringify(allSchedules));
    console.log(
      `GTFS procesado con éxito: ${allStops.length} paradas y ${allRoutes.length} líneas en public/data/network.json`
    );
    return;
  }

  // Si no hay archivos GTFS locales todavía, sincronizar desde la API oficial MovGR
  const networkPayload = await syncFromMovGrApi();
  fs.writeFileSync(path.join(OUT_DIR, 'network.json'), JSON.stringify(networkPayload));
  if (!fs.existsSync(path.join(OUT_DIR, 'schedules.json'))) {
    fs.writeFileSync(path.join(OUT_DIR, 'schedules.json'), JSON.stringify({}));
  }
  console.log(
    `Red de Granada sincronizada: ${networkPayload.stops.length} paradas y ${networkPayload.routes.length} líneas.`
  );
}

main().catch((err) => {
  console.error('Error procesando GTFS:', err);
  process.exit(1);
});
