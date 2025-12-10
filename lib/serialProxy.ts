import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import { WebSocketServer, WebSocket } from 'ws';

let serial: SerialPort | null = null;
let wss: WebSocketServer | null = null;

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

function parseFrame(text: string): SensorFrame | null {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 7) return null;

  const getNum = (line: string, key: string) => {
    const idx = line.indexOf(key);
    if (idx === -1) return NaN;
    const part = line.slice(idx + key.length).trim();
    const numStr = part.split(' ')[0].replace(',', '');
    return Number(numStr);
  };

  const accelLine = lines[1]; // Acceleration X: 1.221, Y: 155.834, Z: 16.549 m/s^2
  const rotLine   = lines[2];
  const mpuLine   = lines[3];
  const dsLine    = lines[4];
  const capLine   = lines[5];
  const irLine    = lines[6];
  const hallLine  = lines[7];

  // basic parsing, assumes same format each frame
  const accelX = getNum(accelLine, 'Acceleration X:');
  const accelY = getNum(accelLine, 'Y:');
  const accelZ = getNum(accelLine, 'Z:');

  const rotX = getNum(rotLine, 'Rotation X:');
  const rotY = getNum(rotLine, 'Y:');
  const rotZ = getNum(rotLine, 'Z:');

  const mpuTemp = getNum(mpuLine, 'MPU Temperature:');
  const ds18b20 = getNum(dsLine, 'DS18B20 Temp (C):');
  const capacitiveTouch = getNum(capLine, 'Capacitive Touch:');
  const irPhotodiode = getNum(irLine, 'IR Photodiode (0-4095):');
  const hallSensor = getNum(hallLine, 'Hall Sensor (0-4095):');

  return {
    accelX,
    accelY,
    accelZ,
    rotX,
    rotY,
    rotZ,
    mpuTemp,
    ds18b20,
    capacitiveTouch,
    irPhotodiode,
    hallSensor,
  };
}

export async function startSerialProxy(
  portPath: string = 'COM4',  // change to your port
  baudRate: number = 115200   // match your sketch
) {
  if (serial) return; // avoid double init

  serial = new SerialPort({ path: portPath, baudRate });
  const parser = serial.pipe(new ReadlineParser({ delimiter: '\n======== SENSOR FRAME ========' }));

  wss = new WebSocketServer({ port: 8080 });

  wss.on('connection', (socket: WebSocket) => {
    console.log('Client connected to serial WS');

    parser.on('data', (chunk: string) => {
      const text = chunk.toString().trim();
      const frame = parseFrame(text);
      if (!frame) return;
      socket.send(JSON.stringify(frame));
    });
  });

  console.log(`Serial proxy running on ws://localhost:8080 (port: ${portPath})`);
}
