import type { Route, Stop } from './types';

export interface OrderedDirection {
  index: number;
  label: string;
  subtitle: string;
  stops: Stop[];
}

interface ProjectionResult {
  distMeters: number;
  alongMeters: number;
}

function projectStopOntoPolyline(stop: Stop, points: [number, number][]): ProjectionResult {
  if (points.length === 0) {
    return { distMeters: Infinity, alongMeters: 0 };
  }
  const ky = 111320;
  const kx = 111320 * Math.cos((stop.lat * Math.PI) / 180);
  const px = stop.lon * kx;
  const py = stop.lat * ky;

  if (points.length === 1) {
    const dx = px - points[0][1] * kx;
    const dy = py - points[0][0] * ky;
    return { distMeters: Math.hypot(dx, dy), alongMeters: 0 };
  }

  let bestDist = Infinity;
  let bestAlong = 0;
  let accMeters = 0;

  for (let i = 0; i < points.length - 1; i++) {
    const ax = points[i][1] * kx;
    const ay = points[i][0] * ky;
    const bx = points[i + 1][1] * kx;
    const by = points[i + 1][0] * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    const segLen = Math.sqrt(lenSq);

    const t = lenSq > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq)) : 0;
    const projX = ax + t * dx;
    const projY = ay + t * dy;
    const dist = Math.hypot(px - projX, py - projY);

    if (dist < bestDist) {
      bestDist = dist;
      bestAlong = accMeters + t * segLen;
    }
    accMeters += segLen;
  }

  return { distMeters: bestDist, alongMeters: bestAlong };
}

export function buildOrderedDirections(route: Route, allStops: Stop[]): OrderedDirection[] {
  const routeStops = allStops.filter(
    (s) => s.mode === route.mode && s.lines.includes(route.id)
  );

  if (routeStops.length === 0 || route.shapes.length === 0) {
    return [
      {
        index: 0,
        label: 'Paradas',
        subtitle: '',
        stops: routeStops,
      },
    ];
  }

  const shapes = route.shapes.slice(0, 2);

  if (shapes.length === 1) {
    const ordered = routeStops
      .map((stop) => ({ stop, ...projectStopOntoPolyline(stop, shapes[0].points) }))
      .sort((a, b) => a.alongMeters - b.alongMeters)
      .map((entry) => entry.stop);

    const subtitle =
      ordered.length >= 2 ? `${ordered[0].name} → ${ordered[ordered.length - 1].name}` : '';
    return [
      {
        index: 0,
        label: 'Recorrido',
        subtitle,
        stops: ordered,
      },
    ];
  }

  // Dos sentidos (Ida / Vuelta): proyectar cada parada sobre ambos trazados
  const projectionsByStop = routeStops.map((stop) => ({
    stop,
    p0: projectStopOntoPolyline(stop, shapes[0].points),
    p1: projectStopOntoPolyline(stop, shapes[1].points),
  }));

  const dir0Entries: Array<{ stop: Stop; along: number }> = [];
  const dir1Entries: Array<{ stop: Stop; along: number }> = [];

  for (const item of projectionsByStop) {
    const { stop, p0, p1 } = item;
    const in0 = p0.distMeters <= 80 || p0.distMeters <= p1.distMeters * 1.15;
    const in1 = p1.distMeters <= 80 || p1.distMeters <= p0.distMeters * 1.15;

    if (in0) dir0Entries.push({ stop, along: p0.alongMeters });
    if (in1) dir1Entries.push({ stop, along: p1.alongMeters });
  }

  dir0Entries.sort((a, b) => a.along - b.along);
  dir1Entries.sort((a, b) => a.along - b.along);

  const dirs: OrderedDirection[] = [];

  const list0 =
    dir0Entries.length > 0
      ? dir0Entries.map((e) => e.stop)
      : projectionsByStop
          .slice()
          .sort((a, b) => a.p0.alongMeters - b.p0.alongMeters)
          .map((e) => e.stop);

  const list1 =
    dir1Entries.length > 0
      ? dir1Entries.map((e) => e.stop)
      : projectionsByStop
          .slice()
          .sort((a, b) => a.p1.alongMeters - b.p1.alongMeters)
          .map((e) => e.stop);

  dirs.push({
    index: 0,
    label: 'Ida',
    subtitle: list0.length >= 2 ? `${list0[0].name} → ${list0[list0.length - 1].name}` : '',
    stops: list0,
  });

  dirs.push({
    index: 1,
    label: 'Vuelta',
    subtitle: list1.length >= 2 ? `${list1[0].name} → ${list1[list1.length - 1].name}` : '',
    stops: list1,
  });

  return dirs;
}
