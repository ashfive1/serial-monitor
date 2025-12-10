'use client';
import { useEffect, useState } from 'react';

export default function SerialMonitor() {
  const [data, setData] = useState<string[]>([]);
  const [ws, setWs] = useState<WebSocket | null>(null);

  useEffect(() => {
    const websocket = new WebSocket('ws://localhost:8080');
    websocket.onmessage = (event) => {
      setData(prev => [...prev.slice(-50), event.data]);  // Keep last 50 lines
    };
    setWs(websocket);
    return () => websocket.close();
  }, []);

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Arduino Serial Monitor</h1>
      <div className="bg-black text-green-400 p-4 h-96 overflow-y-auto font-mono text-sm">
        {data.map((line, i) => <div key={i}>{line}</div>)}
      </div>
    </div>
  );
}
