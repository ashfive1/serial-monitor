import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import { WebSocketServer, WebSocket } from 'ws';

let serial: SerialPort | null = null;
let wss: WebSocketServer | null = null;

export async function startSerialProxy(
  portPath: string = '/dev/ttyACM0',
  baudRate: number = 9600
) {
  serial = new SerialPort({ path: portPath, baudRate });
  const parser = serial.pipe(new ReadlineParser({ delimiter: '\n' }));

  wss = new WebSocketServer({ port: 8080 });

  wss.on('connection', (socket: WebSocket) => {
    console.log('Client connected to serial WS');
    parser.on('data', (data) => {
      socket.send(data.toString().trim());
    });
  });

  console.log(`Serial proxy running on ws://localhost:8080 (port: ${portPath})`);
}
