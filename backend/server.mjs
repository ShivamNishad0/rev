import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const PORT = process.env.PORT || 3000;
const GENAI_KEY = process.env.GENAI_API_KEY;
if (!GENAI_KEY) {
  console.error('Please set GENAI_API_KEY in .env');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GENAI_KEY });
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

function findAudioInEvent(ev) {
  if (!ev) return null;
  if (ev.audio?.data) return { data: ev.audio.data, sampleRate: ev.audio.sampleRate || 24000, mimeType: ev.audio.mimeType || 'audio/pcm' };
  if (Array.isArray(ev.outputs)) {
    for (const o of ev.outputs) {
      if (o?.audio?.data) return { data: o.audio.data, sampleRate: o.audio.sampleRate || 24000, mimeType: o.audio.mimeType || 'audio/pcm' };
    }
  }
  if (ev.response?.audio?.data) return { data: ev.response.audio.data, sampleRate: ev.response.audio.sampleRate || 24000, mimeType: ev.response.audio.mimeType || 'audio/pcm' };
  return null;
}

async function createLiveSession(ws) {
  const model = 'models/gemini-2.5-flash-preview-native-audio-dialog';
  const systemInstruction = {
    parts: [{ text: 'You only answer about Revolt Motors. Politely decline other topics.' }]
  };

  const callbacks = {
    onopen: () => ws.send(JSON.stringify({ type: 'session_open' })),
    onmessage: (msg) => {
      const audio = findAudioInEvent(msg);
      if (audio?.data) {
        ws.send(JSON.stringify({ type: 'ai_audio', payload: audio }));
      } else {
        ws.send(JSON.stringify({ type: 'ai_event', payload: msg }));
      }
    },
    onerror: (e) => ws.send(JSON.stringify({ type: 'ai_error', error: String(e) })),
    onclose: () => ws.send(JSON.stringify({ type: 'session_closed' }))
  };

  const config = {
    responseModalities: [Modality.AUDIO],
    systemInstruction,
    realtimeInputConfig: { automaticActivityDetection: {} },
    audioConfig: { targetSampleRate: 24000 }
  };

  return await ai.live.connect({ model, config, callbacks });
}

wss.on('connection', async (ws) => {
  let session;
  try {
    session = await createLiveSession(ws);
  } catch (e) {
    ws.send(JSON.stringify({ type: 'fatal', error: String(e) }));
    ws.close();
    return;
  }

  ws.on('message', async (message) => {
    let obj;
    try { obj = JSON.parse(message.toString()); } catch { return; }
    if (obj.type === 'audio') {
      await session.sendRealtimeInput({ audio: { data: obj.data, mimeType: 'audio/pcm;rate=16000' } });
    } else if (obj.type === 'activityEnd') {
      await session.sendRealtimeInput({ activityEnd: {} });
    } else if (obj.type === 'interrupt' || obj.type === 'stopPlayback') {
      if (session.interrupt) await session.interrupt();
    }
  });

  ws.on('close', () => session?.close());
});

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => console.log(`Backend running at http://localhost:${PORT}`));
