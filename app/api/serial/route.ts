import { NextResponse } from 'next/server';
import { startSerialProxy } from '@/lib/serialProxy';

export async function GET() {
  try {
    await startSerialProxy();  // Customize port/baud as needed
    return NextResponse.json({ status: 'Serial proxy started on ws://localhost:8080' });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to start proxy', details: error }, { status: 500 });
  }
}
