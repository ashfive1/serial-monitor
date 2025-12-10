'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';

export const IDEAL = {
  temperatureC: 25,
  capacitiveRaw: 500,
  photodiodeRaw: 0,
  hallRaw: 0,
  intensityPct: 0,
} as const;

export type Level = 'good' | 'ok' | 'bad';

export function classify(value: number, ideal: number): Level {
  const diff = Math.abs(value - ideal);
  const small = 0.1 * Math.max(1, Math.abs(ideal)); // ≤10% good
  const medium = 0.3 * Math.max(1, Math.abs(ideal)); // ≤30% ok
  if (diff <= small) return 'good';
  if (diff <= medium) return 'ok';
  return 'bad';
}

export function levelToBarClass(level: Level): string {
  if (level === 'good') return 'bg-emerald-500';
  if (level === 'ok') return 'bg-orange-500';
  return 'bg-red-500';
}

/** Raw shape coming from WS (unknown types possible) */
type RawFrame = Record<string, unknown>;

/** Normalized frame used by UI: numeric fields guaranteed as numbers */
type SanitizedFrame = {
  temperatureC: number;
  capacitiveRaw: number;
  photodiodeRaw: number;
  hallRaw: number;
  intensityPct: number;
  vibrationState?: string;
};

const DEFAULT_FRAME: SanitizedFrame = {
  temperatureC: 0,
  capacitiveRaw: 0,
  photodiodeRaw: 0,
  hallRaw: 0,
  intensityPct: 0,
};

/** Convert any incoming raw frame to SanitizedFrame. Non-numeric → NaN → fallback to 0. */
function sanitizeFrame(raw: RawFrame | null): SanitizedFrame {
  if (!raw) return DEFAULT_FRAME;
  const toNum = (v: unknown) => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = Number(v.trim());
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  };

  return {
    temperatureC: toNum(raw['temperatureC'] ?? raw['Temperature (C)'] ?? raw['temperature'] ?? 0),
    capacitiveRaw: toNum(raw['capacitiveRaw'] ?? raw['Capacitive raw'] ?? raw['capacitive'] ?? 0),
    photodiodeRaw: toNum(raw['photodiodeRaw'] ?? raw['Photodiode raw'] ?? raw['photodiode'] ?? 0),
    hallRaw: toNum(raw['hallRaw'] ?? raw['Hall raw'] ?? raw['hall'] ?? 0),
    intensityPct: toNum(raw['intensityPct'] ?? raw['Intensity%'] ?? raw['intensity'] ?? 0),
    vibrationState:
      typeof raw['vibrationState'] === 'string'
        ? (raw['vibrationState'] as string)
        : typeof raw['VIBRATION'] === 'string'
        ? (raw['VIBRATION'] as string)
        : typeof raw['vibration'] === 'string'
        ? (raw['vibration'] as string)
        : undefined,
  };
}

/** Bar configuration */
type BarConfig = {
  label: string;
  key: keyof SanitizedFrame;
  min: number;
  max: number;
  unit?: string;
  ideal: number;
};

const bars: BarConfig[] = [
  { label: 'Temperature', key: 'temperatureC', min: -20, max: 60, unit: '°C', ideal: IDEAL.temperatureC },
  { label: 'Capacitive Raw', key: 'capacitiveRaw', min: 0, max: 2000, unit: '', ideal: IDEAL.capacitiveRaw },
  { label: 'Photodiode Raw', key: 'photodiodeRaw', min: 0, max: 4095, unit: '', ideal: IDEAL.photodiodeRaw },
  { label: 'Hall Raw', key: 'intensityPct', min: 0, max: 100, unit: '%', ideal: IDEAL.intensityPct },
];

export default function Page() {
  const [frame, setFrame] = useState<SanitizedFrame>(DEFAULT_FRAME);
  const [connected, setConnected] = useState(false);
  const [statusText, setStatusText] = useState('idle');
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempt = useRef(0);
  const mounted = useRef(true);

  // create ws + reconnect with exponential backoff
  useEffect(() => {
    mounted.current = true;
    const connect = () => {
      setStatusText('connecting');
      const ws = new WebSocket('ws://localhost:8080');
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mounted.current) return;
        reconnectAttempt.current = 0;
        setConnected(true);
        setStatusText('connected');
      };

      ws.onmessage = (evt) => {
        try {
          const raw = JSON.parse(evt.data) as RawFrame;
          const sanitized = sanitizeFrame(raw);
          setFrame(sanitized);
        } catch (e) {
          console.warn('Bad WS frame', e);
        }
      };

      ws.onerror = (e) => {
        console.warn('WS error', e);
      };

      ws.onclose = () => {
        if (!mounted.current) return;
        setConnected(false);
        setStatusText('disconnected');
        // exponential backoff capped at ~16s
        reconnectAttempt.current = Math.min(6, reconnectAttempt.current + 1);
        const waitMs = Math.pow(2, reconnectAttempt.current) * 500;
        setStatusText(`reconnecting in ${Math.round(waitMs / 1000)}s`);
        setTimeout(() => {
          if (!mounted.current) return;
          connect();
        }, waitMs);
      };
    };

    connect();

    return () => {
      mounted.current = false;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  const vibrationState = frame.vibrationState ?? '';

  const vibrationIsAlert = useMemo(() => {
    if (!vibrationState) return false;
    const s = vibrationState.toLowerCase();
    // treat anything that is not "normal" as alert (tunable)
    if (s.includes('normal')) return false;
    if (s.includes('no vibration') || s.includes('none')) return false;
    return true;
  }, [vibrationState]);

  const renderRow = (cfg: BarConfig) => {
    // value is guaranteed by SanitizedFrame
    const value = frame[cfg.key] as number;
    const clamped = Math.max(cfg.min, Math.min(cfg.max, value));
    const pct = ((clamped - cfg.min) / (cfg.max - cfg.min || 1)) * 100;

    const level = classify(value, cfg.ideal);
    const barColor = levelToBarClass(level);

    return (
      <div key={cfg.key} className="mb-4">
        <div className="flex items-center gap-4">
          <div className="w-44 text-sm text-gray-300">
            <div className="font-medium">{cfg.label}</div>
            <div className="text-xs text-gray-500">
              Ideal: {cfg.ideal}
              {cfg.unit ? ` ${cfg.unit}` : ''}
            </div>
          </div>

          <div className="flex-1">
            <div className="flex justify-between text-xs mb-1">
              <span>
                Live: <span className="font-medium">{value.toFixed(2)}</span> {cfg.unit ?? ''}
              </span>
              <span className="text-gray-500">
                {cfg.min} – {cfg.max}
              </span>
            </div>

            <div className="w-full h-4 bg-gray-800 rounded overflow-hidden">
              <div
                className={`h-4 rounded ${barColor}`}
                style={{
                  width: `${pct}%`,
                  transition: 'width 400ms ease, background-color 300ms ease',
                }}
              />
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <main className="min-h-screen bg-black text-gray-100 flex items-center justify-center p-6">
      <div className="w-full max-w-4xl">
        <header className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">Sensor Dashboard</h1>

          <div className="flex items-center gap-3">
            <div className={`px-3 py-1 rounded-full text-xs ${connected ? 'bg-emerald-600' : 'bg-red-700'}`}>
              {connected ? 'Connected' : 'Disconnected'}
            </div>
            <div className="text-xs text-gray-400">{statusText}</div>
          </div>
        </header>

        <section className="bg-gray-900 rounded p-6">
          {bars.map(renderRow)}

          <div className="mt-6 flex items-center gap-4">
            <div className="flex-1">
              <div className="text-sm text-gray-300">Vibration State</div>
              <div className="mt-2 flex items-center gap-3">
                <div
                  className={`px-3 py-2 rounded-md text-sm font-medium ${
                    vibrationIsAlert ? 'bg-red-800 text-red-100' : 'bg-emerald-900 text-emerald-200'
                  }`}
                  // subtle pulse when alert
                  style={{
                    boxShadow: vibrationIsAlert ? '0 0 12px rgba(255,69,58,0.12)' : undefined,
                    transition: 'box-shadow 300ms ease, transform 200ms ease',
                    transform: vibrationIsAlert ? 'scale(1.02)' : 'scale(1)',
                  }}
                >
                  {vibrationState || 'UNKNOWN'}
                </div>

                {/* small intensity badge */}
                <div className="text-sm text-gray-400">
                  Intensity: <span className="font-medium">{frame.intensityPct.toFixed(0)}%</span>
                </div>

                {/* quick raw snapshot */}
                <div className="ml-auto text-xs text-gray-500">
                  Temp: {frame.temperatureC.toFixed(2)}°C · Cap: {frame.capacitiveRaw} · Photo: {frame.photodiodeRaw}
                </div>
              </div>
            </div>
          </div>
        </section>

        <footer className="mt-6 text-xs text-gray-500">
          Live data from <code>ws://localhost:8080</code>. Ensure the serial proxy is running and COM4 is free.
        </footer>
      </div>
    </main>
  );
}
