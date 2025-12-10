// lib/serialProxy.ts  (fixed: prefer number after colon / last number on line)
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import { WebSocketServer, WebSocket } from 'ws';

const SERIAL_PORT = 'COM4';
const BAUD_RATE = 115200;
const WS_PORT = 8080;

const WAIT_MS_IF_MISSING = 150;

let serial: SerialPort | null = null;
let parser: ReadlineParser | null = null;
let wss: WebSocketServer | null = null;

type SensorFrame = {
  temperatureC?: number;
  capacitiveRaw?: number;
  photodiodeRaw?: number;
  hallRaw?: number;
  intensityPct?: number;
  vibrationState?: string;
  [k: string]: any;
};

/**
 * Prefer the number after the last colon (": 123"), otherwise return the last numeric token in the text.
 * This avoids accidentally reading "0" from "(0-4095)" which appears before the actual reading.
 */
function findNumberAfterColonOrLast(text: string): number | null {
  if (!text) return null;
  // try match numbers that come after a colon, e.g. ": 1431"
  const afterColon = [...text.matchAll(/:\s*(-?\d+(\.\d+)?)/g)];
  if (afterColon.length > 0) {
    const last = afterColon[afterColon.length - 1];
    return Number(last[1]);
  }
  // fallback: take the last numeric token in the string
  const allNums = [...text.matchAll(/-?\d+(\.\d+)?/g)];
  if (allNums.length === 0) return null;
  const lastNum = allNums[allNums.length - 1][0];
  return Number(lastNum);
}

/** Legacy helper kept for lines that are simple (but we will prefer the improved function) */
function findLastNumber(text: string): number | null {
  const all = [...text.matchAll(/-?\d+(\.\d+)?/g)];
  if (all.length === 0) return null;
  return Number(all[all.length - 1][0]);
}

/** Parse an array of trimmed lines (one frame) into a SensorFrame */
function parseLinesToFrame(lines: string[]): SensorFrame | null {
  if (!lines || lines.length === 0) return null;
  const frame: SensorFrame = {};

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // Temperature (C): 24.40
    if (/temperature\s*\(c\)/i.test(line) || /^temp\s*[:]/i.test(line)) {
      const n = findNumberAfterColonOrLast(line);
      if (n !== null) frame.temperatureC = n;
      continue;
    }

    // Capacitive raw (touchRead): 732
    if (/capacitive\s+raw|touchread/i.test(line)) {
      const n = findNumberAfterColonOrLast(line);
      if (n !== null) frame.capacitiveRaw = n;
      continue;
    }

    // Photodiode raw (0-4095): 86  OR "photoRaw: 86" etc.
    if (/photodiode|photo\s*raw|photoraw|photoRaw/i.test(line)) {
      const n = findNumberAfterColonOrLast(line);
      if (n !== null) frame.photodiodeRaw = n;
      continue;
    }

    // Hall raw (0-4095): 4095    Intensity%: 0
    if (/hall\s+raw|hall\s*\(/i.test(line)) {
      // prefer number after colon (the actual reading)
      const n = findNumberAfterColonOrLast(line);
      if (n !== null) frame.hallRaw = n;
      // intensity on same line (or separate)
      const intN = (line.match(/Intensity%?\s*[:\s]\s*(-?\d+(\.\d+)?)/i) || [])[1];
      if (intN !== undefined) frame.intensityPct = Number(intN);
      else {
        // fallback: if there's another number later, use last numeric token for intensity
        const allNums = [...line.matchAll(/-?\d+(\.\d+)?/g)];
        if (allNums.length >= 2) {
          const last = allNums[allNums.length - 1][0];
          const lastVal = Number(last);
          if (!Number.isNaN(lastVal) && lastVal !== frame.hallRaw) frame.intensityPct = lastVal;
        }
      }
      continue;
    }

    // Intensity% in its own line
    if (/intensity%|intensity\s*%/i.test(line)) {
      const n = findNumberAfterColonOrLast(line);
      if (n !== null) frame.intensityPct = n;
      continue;
    }

    // Vibration state (NORMAL / ABNORMAL)
    if (/vibration/i.test(line)) {
      frame.vibrationState = line;
      continue;
    }

    // Generic key:value fallback
    const kv = line.match(/^(.+?)\s*:\s*(.+)$/);
    if (kv) {
      const keyRaw = kv[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
      const valRaw = kv[2].trim();
      const n = findNumberAfterColonOrLast(valRaw);
      frame[keyRaw] = n !== null ? n : valRaw;
      continue;
    }

    // Fallback: single numeric line -> fill slots
    const singleNum = findLastNumber(line);
    if (singleNum !== null) {
      if (frame.temperatureC === undefined) frame.temperatureC = singleNum;
      else if (frame.capacitiveRaw === undefined) frame.capacitiveRaw = singleNum;
      else if (frame.photodiodeRaw === undefined) frame.photodiodeRaw = singleNum;
      else if (frame.hallRaw === undefined) frame.hallRaw = singleNum;
      else if (frame.intensityPct === undefined) frame.intensityPct = singleNum;
    }
  }

  const hasAny =
    typeof frame.temperatureC === 'number' ||
    typeof frame.capacitiveRaw === 'number' ||
    typeof frame.photodiodeRaw === 'number' ||
    typeof frame.hallRaw === 'number' ||
    typeof frame.intensityPct === 'number' ||
    typeof frame.vibrationState === 'string';

  return hasAny ? frame : null;
}

/** Broadcast helper */
function broadcastFrame(frame: SensorFrame) {
  const payload = JSON.stringify(frame);
  console.log('Broadcast JSON:', payload);
  wss?.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(payload);
      } catch (e) {
        console.warn('Failed to send WS payload', e);
      }
    }
  });
}

/** Wait helper to collect extra lines up to timeoutMs */
function waitForExtraLines(timeoutMs: number, parserRef: ReadlineParser): Promise<string[]> {
  return new Promise((resolve) => {
    const extra: string[] = [];
    let resolved = false;

    const onData = (l: string) => {
      const t = String(l).replace(/\r?\n$/, '').trim();
      if (t.length > 0) extra.push(t);
    };

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        parserRef.removeListener('data', onData);
        resolve(extra);
      }
    };

    parserRef.on('data', onData);
    setTimeout(cleanup, timeoutMs);
  });
}

export function startSerialProxy(portPath = SERIAL_PORT, baudRate = BAUD_RATE, wsPort = WS_PORT) {
  if (serial) {
    console.warn('Serial proxy already running.');
    return;
  }

  console.log(`Starting serial proxy -> ${portPath}@${baudRate} -> ws://localhost:${wsPort}`);

  serial = new SerialPort({ path: portPath, baudRate, autoOpen: true });

  serial.on('open', () => console.log('Serial port opened'));
  serial.on('error', (err) => console.error('Serial error:', err));
  serial.on('close', () => {
    console.log('Serial closed');
    serial = null;
    parser = null;
  });

  parser = serial.pipe(new ReadlineParser({ delimiter: '\n' }));

  if (!wss) {
    wss = new WebSocketServer({ port: wsPort });
    wss.on('listening', () => console.log(`WS listening ws://localhost:${wsPort}`));
    wss.on('connection', (sock) => {
      console.log('WS client connected');
      sock.on('close', () => console.log('WS client disconnected'));
      sock.on('error', (e) => console.warn('WS client error', e));
    });
    wss.on('error', (e) => console.error('WS server error', e));
  }

  let buffer: string[] = [];
  const SEPARATOR_RE = /^-{3,}$/;
  let isWaitingForExtra = false;

  parser.on('data', async (line: string) => {
    const text = String(line).replace(/\r?\n$/, '');
    const trimmed = text.trim();

    console.log('<<LINE>>', trimmed);

    // Separator line arrived
    if (SEPARATOR_RE.test(trimmed)) {
      if (buffer.length > 0) {
        console.log('<<FRAME ASSEMBLED>>\n', buffer.join('\n'));
        const frame = parseLinesToFrame(buffer);
        if (!frame) {
          console.warn('Parse failed for assembled frame');
        } else {
          if (frame.photodiodeRaw === undefined && !isWaitingForExtra) {
            isWaitingForExtra = true;
            console.log('Photodiode missing in assembled frame — waiting for extra lines...');
            const extras = await waitForExtraLines(WAIT_MS_IF_MISSING, parser!);
            if (extras.length > 0) {
              console.log('Extra lines received while waiting:', extras);
              buffer.push(...extras);
            }
            isWaitingForExtra = false;
            const reframe = parseLinesToFrame(buffer);
            if (reframe) broadcastFrame(reframe);
            else console.warn('Reparse failed after waiting for extra lines');
          } else {
            broadcastFrame(frame);
          }
        }
        buffer = [];
      } else {
        buffer = [];
      }
      return;
    }

    if (trimmed.length > 0) buffer.push(trimmed);

    if (/vibration/i.test(trimmed)) {
      const currentlyHasPhoto = buffer.some((l) => /photodiode|photo\s*raw|photoraw|photoRaw/i.test(l));
      if (!currentlyHasPhoto && !isWaitingForExtra) {
        isWaitingForExtra = true;
        console.log('Vibration seen but photodiode not in buffer — waiting for extra lines...');
        const extras = await waitForExtraLines(WAIT_MS_IF_MISSING, parser!);
        if (extras.length > 0) {
          console.log('Extra lines received while waiting (vibration path):', extras);
          buffer.push(...extras);
        }
        isWaitingForExtra = false;
      }

      console.log('<<FRAME ASSEMBLED (via vibration)>>\n', buffer.join('\n'));
      const frame = parseLinesToFrame(buffer);
      if (!frame) {
        console.warn('Parse failed for assembled frame (vibration end)');
      } else {
        broadcastFrame(frame);
      }
      buffer = [];
      return;
    }

    if (buffer.length > 1000) {
      console.warn('Frame buffer overflow, resetting buffer');
      buffer = [];
    }
  });

  parser.on('error', (e) => console.error('Parser error', e));

  const shutdown = () => {
    console.log('Shutting down serial proxy...');
    try {
      parser?.removeAllListeners();
      serial?.close((err) => { if (err) console.warn('Error closing serial', err); });
      wss?.close(() => console.log('WS closed'));
    } catch (e) {
      console.warn('Shutdown error', e);
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Auto-start
startSerialProxy();
