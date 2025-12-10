'use client';

import { useEffect, useState } from 'react';

export const IDEAL = {
  mpuTemp: 25,          // °C
  ds18b20: 25,          // °C
  capacitiveTouch: 500, // arbitrary
  irPhotodiode: 0,      // dark baseline
  hallSensor: 0,        // zero field
  rotX: 0,
  rotY: 0,
  rotZ: 0,
};

export type Level = 'good' | 'ok' | 'bad';

// percentage difference thresholds (you can tune per-sensor if needed)
export function classify(value: number, ideal: number): Level {
  const diff = Math.abs(value - ideal);

  const small = 0.1 * Math.max(1, Math.abs(ideal));  // ≤10% → good
  const medium = 0.3 * Math.max(1, Math.abs(ideal)); // 10–30% → ok

  if (diff <= small) return 'good';
  if (diff <= medium) return 'ok';
  return 'bad';
}

export function levelToBarClass(level: Level): string {
  if (level === 'good') return 'bg-emerald-500';
  if (level === 'ok') return 'bg-orange-500';
  return 'bg-red-500';
}

type SensorFrame = {
  accelX: number;
  accelY: number;
  accelZ: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  mpuTemp: number;
  ds18b20: number;
  capacitiveTouch: number;
  irPhotodiode: number;
  hallSensor: number;
};

type BarConfig = {
  label: string;
  key: keyof SensorFrame;
  min: number;
  max: number;
  unit?: string;
  ideal?: number;              // <-- add ideal here
};

const bars: BarConfig[] = [
  { label: 'Accel X', key: 'accelX', min: -20, max: 20, unit: 'm/s²' },
  { label: 'Accel Y', key: 'accelY', min: -200, max: 200, unit: 'm/s²' },
  { label: 'Accel Z', key: 'accelZ', min: -20, max: 20, unit: 'm/s²' },
  { label: 'Rot X', key: 'rotX', min: -10, max: 10, unit: 'rad/s', ideal: IDEAL.rotX },
  { label: 'Rot Y', key: 'rotY', min: -10, max: 10, unit: 'rad/s', ideal: IDEAL.rotY },
  { label: 'Rot Z', key: 'rotZ', min: -10, max: 10, unit: 'rad/s', ideal: IDEAL.rotZ },
  { label: 'DS18B20', key: 'ds18b20', min: -40, max: 125, unit: '°C', ideal: IDEAL.ds18b20 },
  { label: 'Cap Touch', key: 'capacitiveTouch', min: 0, max: 2000, ideal: IDEAL.capacitiveTouch },
  { label: 'IR Photodiode', key: 'irPhotodiode', min: 0, max: 4095, ideal: IDEAL.irPhotodiode },
  { label: 'Hall Sensor', key: 'hallSensor', min: 0, max: 4095, ideal: IDEAL.hallSensor },
];

export default function Page() {
  const [frame, setFrame] = useState<SensorFrame | null>(null);

  useEffect(() => {
    const ws = new WebSocket('ws://localhost:8080');
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as SensorFrame;
        setFrame(data);
      } catch (e) {
        console.error('Bad WS data', e);
      }
    };
    return () => ws.close();
  }, []);

  const renderRow = (cfg: BarConfig) => {
    const value = frame ? frame[cfg.key] ?? 0 : 0;
    const clamped = Math.max(cfg.min, Math.min(cfg.max, value));
    const pct = ((clamped - cfg.min) / (cfg.max - cfg.min || 1)) * 100;

    const ideal = cfg.ideal ?? 0;
    const level = classify(value, ideal);
    const barColor = levelToBarClass(level);

    return (
      <div key={cfg.key as string} className="mb-4">
        <div className="flex items-center gap-4">
          {/* Left: ideal value placeholder */}
          <div className="w-40 text-sm text-gray-300">
            <div className="font-medium">{cfg.label}</div>
            <div className="text-xs text-gray-500">
              Ideal: {ideal.toFixed(2)} {cfg.unit ?? ''}
            </div>
          </div>

          {/* Right: live value + bar */}
          <div className="flex-1">
            <div className="flex justify-between text-xs mb-1">
              <span>
                Live: {value.toFixed(2)} {cfg.unit ?? ''}
              </span>
              <span className="text-gray-500">
                {cfg.min} – {cfg.max}
              </span>
            </div>
            <div className="w-full h-4 bg-gray-800 rounded">
              <div
                className={`h-4 rounded ${barColor}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <main className="min-h-screen bg-black text-gray-100 flex items-center justify-center">
      <div className="w-full max-w-4xl p-6">
        <h1 className="text-2xl font-bold mb-4">Sensor Dashboard</h1>
        {!frame && <p className="text-sm text-gray-400 mb-4">Waiting for data…</p>}
        {bars.map(renderRow)}
      </div>
    </main>
  );
}
