export type TransitMode = 'urbano' | 'interurbano' | 'metro';

export interface Stop {
  id: string;
  code: string;
  apiId?: string;
  name: string;
  lat: number;
  lon: number;
  mode: TransitMode;
  municipality?: string | null;
  lines: string[];
}

export interface RouteShape {
  direction: number;
  points: [number, number][];
}

export interface Route {
  id: string;
  name: string;
  color: string;
  textColor: string;
  mode: TransitMode;
  shapes: RouteShape[];
}

export interface NetworkData {
  generatedAt: string;
  source: string;
  stops: Stop[];
  routes: Route[];
}

export interface ArrivalItem {
  lineId: string;
  lineName?: string;
  color: string;
  textColor: string;
  destination: string;
  minutes: number;
  timeText?: string;
  inRoute?: boolean;
}

export interface VehicleItem {
  lineId: string;
  direction: number;
  lat: number;
  lon: number;
  seenAt?: string | null;
}

export type DayBucket = 'wd' | 'sa' | 'su' | 'all';

export type ScheduleLineMap = Record<string, number[]>;

export type StopScheduleBuckets = Partial<Record<DayBucket, ScheduleLineMap>>;

export interface StopArrivalsResult {
  source: 'realtime' | 'gtfs' | 'unavailable';
  arrivals: ArrivalItem[];
  gtfsArrivals: ArrivalItem[];
  gtfsDayLabel?: string;
  hasGtfsData?: boolean;
  vehicles: VehicleItem[];
  error?: string;
}

export type ScheduleData = Record<string, StopScheduleBuckets | ScheduleLineMap>;
