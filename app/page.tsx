'use client';

import { useEffect, useState } from 'react';

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
};

const bars: BarConfig[] = [
  { label: 'Accel X', key: 'accelX', min: -20, max: 20, unit: 'm/s²' },
  { label: 'Accel Y', key: 'accelY', min: -200, max: 200, unit: 'm/s²' },
  { label: 'Accel Z', key: 'accelZ', min: -20, max: 20, unit: 'm/s²' },
  { label: 'Rot X', key: 'rotX', min: -10, max: 10, unit: 'rad/s' },
  { label: 'Rot Y', key: 'rotY', min: -10, max: 10, unit: 'rad/s' },
  { label: 'Rot Z', key: 'rotZ', min: -10, max: 10, unit: 'rad/s' },
  { label: 'MPU Temp', key: 'mpuTemp', min: -40, max: 85, unit: '°C' },
  { label: 'DS18B20', key: 'ds18b20', min: -40, max: 125, unit: '°C' },
  { label: 'Cap Touch', key: 'capacitiveTouch', min: 0, max: 2000 },
  { label: 'IR Photodiode', key: 'irPhotodiode', min: 0, max: 4095 },
  { label: 'Hall Sensor', key: 'hallSensor', min: 0, max: 4095 },
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

  const renderBar = (cfg: BarConfig) => {
    if (!frame) return null;
    const value = frame[cfg.key] ?? 0;
    const clamped = Math.max(cfg.min, Math.min(cfg.max, value));
    const range = cfg.max - cfg.min || 1;
    const percent = ((clamped - cfg.min) / range) * 100;

    return (
      <div key={cfg.key as string} className="mb-3">
        <div className="flex justify-between text-sm mb-1">
          <span>{cfg.label}</span>
          <span>
            {value.toFixed(2)} {cfg.unit ?? ''}
          </span>
        </div>
        <div className="w-full h-4 bg-gray-800 rounded">
          <div
            className="h-4 bg-emerald-500 rounded"
            style={{ width: `${percent}%` }}
          />
        </div>
        <div className="flex justify-between text-xs text-gray-400 mt-0.5">
          <span>{cfg.min}</span>
          <span>{cfg.max}</span>
        </div>
      </div>
    );
  };

  return (
    <main className="min-h-screen bg-black text-gray-100 flex items-center justify-center">
      <div className="w-full max-w-3xl p-6">
        <h1 className="text-2xl font-bold mb-4">Sensor Dashboard</h1>
        {!frame && <p className="text-sm text-gray-400">Waiting for data…</p>}
        {bars.map(renderBar)}
      </div>
    </main>
  );
}
