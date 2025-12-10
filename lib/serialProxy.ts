// lib/serialProxy.ts
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import { WebSocketServer, WebSocket } from 'ws';

const SERIAL_PORT = 'COM4';
const BAUD_RATE = 115200;
const WS_PORT = 8080;

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
  // keep for compatibility if additional fields appear
  [k: string]: any;
};

function findNumber(text: string): number | null {
  const m = text.match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function parseLinesToFrame(lines: string[]): SensorFrame | null {
  // lines are trimmed and non-empty
  if (!lines || lines.length === 0) return null;
  const frame: SensorFrame = {};

  for (const raw of lines) {
    const line = raw.trim();

    // Temperature (C): 24.40
    if (/temperature\s*\(c\)/i.test(line) || /^temp\s*[:]/i.test(line)) {
      const v = findNumber(line);
      if (v !== null) frame.temperatureC = v;
      continue;
    }

    // Capacitive raw (touchRead): 732
    if (/capacitive\s+raw|touchread/i.test(line)) {
      const v = findNumber(line);
      if (v !== null) frame.capacitiveRaw = v;
      continue;
    }

    // Photodiode raw (0-4095): 86
    if (/photodiode/i.test(line)) {
      const v = findNumber(line);
      if (v !== null) frame.photodiodeRaw = v;
      continue;
    }

    // Hall raw (0-4095): 4095    Intensity%: 0
    if (/hall\s+raw|hall\s*\(/i.test(line)) {
      // Hall value
      const hallMatch = line.match(/hall\s+raw[^\d\-]*(-?\d+)/i);
      if (hallMatch && hallMatch[1]) frame.hallRaw = Number(hallMatch[1]);

      // Intensity on same line
      const intMatch = line.match(/Intensity%?\s*[:\s]\s*(-?\d+(\.\d+)?)/i);
      if (intMatch && intMatch[1]) frame.intensityPct = Number(intMatch[1]);
      else {
        // maybe 'Intensity%: 0' with spacing, re-check generic number
        const fallback = findNumber(line);
        // avoid overriding hallRaw if fallback is hall value only — only set intensity if we found two numbers
        if (fallback !== null) {
          // if hallRaw exists and fallback != hallRaw, treat fallback as intensity
          if (frame.hallRaw === undefined) {
            frame.hallRaw = fallback;
          } else if (fallback !== frame.hallRaw) {
            frame.intensityPct = fallback;
          }
        }
      }
      continue;
    }

    // Intensity% line separate
    if (/intensity%|intensity\s*%/i.test(line)) {
      const v = findNumber(line);
      if (v !== null) frame.intensityPct = v;
      continue;
    }

    // Vibration state lines
    if (/vibration/i.test(line)) {
      frame.vibrationState = line;
      continue;
    }

    // Generic: if line has key:value, parse key
    const kv = line.match(/^(.+?)\s*:\s*(.+)$/);
    if (kv) {
      const key = kv[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
      const val = kv[2].trim();
      const num = findNumber(val);
      frame[key] = num !== null ? num : val;
      continue;
    }

    // Fallback: if single numeric line, pick first available unused key
    const singleNum = findNumber(line);
    if (singleNum !== null) {
      if (frame.temperatureC === undefined) frame.temperatureC = singleNum;
      else if (frame.capacitiveRaw === undefined) frame.capacitiveRaw = singleNum;
      else if (frame.photodiodeRaw === undefined) frame.photodiodeRaw = singleNum;
      else if (frame.hallRaw === undefined) frame.hallRaw = singleNum;
      else if (frame.intensityPct === undefined) frame.intensityPct = singleNum;
    }
  }

  // If nothing meaningful extracted, return null
  const hasAny =
    typeof frame.temperatureC === 'number' ||
    typeof frame.capacitiveRaw === 'number' ||
    typeof frame.photodiodeRaw === 'number' ||
    typeof frame.hallRaw === 'number' ||
    typeof frame.intensityPct === 'number' ||
    typeof frame.vibrationState === 'string';

  return hasAny ? frame : null;
}

export function startSerialProxy(
  portPath = SERIAL_PORT,
  baudRate = BAUD_RATE,
  wsPort = WS_PORT
) {
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

  // Read line-by-line and assemble frames using dashed separator lines
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

  // buffer accumulates lines for the current frame
  let buffer: string[] = [];
  const SEPARATOR_RE = /^-{3,}$/; // matches lines like "-----..."; your sketch prints long dashes

  parser.on('data', (line: string) => {
    const text = String(line).replace(/\r?\n$/, '');
    const trimmed = text.trim();

    // Debug: show incoming lines (comment out later if too chatty)
    console.log('<<LINE>>', trimmed);

    // If it's a separator line
    if (SEPARATOR_RE.test(trimmed)) {
      if (buffer.length > 0) {
        // previous buffer is a complete frame (since the sketch prints separator BEFORE a frame,
        // this will handle frames correctly: when next separator arrives, buffer holds previous frame)
        const assembled = [...buffer]; // copy
        console.log('<<FRAME ASSEMBLED>>\n', assembled.join('\n'));
        const frame = parseLinesToFrame(assembled);
        if (!frame) {
          console.warn('Parse failed for assembled frame');
        } else {
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
        buffer = [];
      } else {
        // first separator or empty buffer: start fresh
        buffer = [];
      }
      // don't add the separator line to buffer
      return;
    }

    // otherwise, add to buffer (collect the frame lines)
    if (trimmed.length > 0) buffer.push(trimmed);

    // safety: if buffer becomes huge, reset
    if (buffer.length > 500) {
      console.warn('Frame buffer overflow, resetting buffer');
      buffer = [];
    }
  });

  parser.on('error', (e) => console.error('Parser error', e));

  // graceful shutdown
  const shutdown = () => {
    console.log('Shutting down serial proxy...');
    try {
      parser?.removeAllListeners();
      serial?.close((err) => {
        if (err) console.warn('Error closing serial', err);
      });
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

// auto-start when run
startSerialProxy();
