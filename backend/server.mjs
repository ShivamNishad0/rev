import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const PORT = process.env.PORT || 3000;
const GENAI_KEY = process.env.GENAI_API_KEY;

if (!GENAI_KEY) {
  console.error('❌ Please set GENAI_API_KEY in .env');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GENAI_KEY });
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Helper to find audio in Gemini's event payload
function findAudioInEvent(ev) {
  if (!ev) return null;
  if (ev.audio?.data) return ev.audio;
  if (Array.isArray(ev.outputs)) {
    for (const o of ev.outputs) {
      if (o?.audio?.data) return o.audio;
    }
  }
  if (ev.response?.audio?.data) return ev.response.audio;
  return null;
}

// Create Gemini live session
async function createLiveSession(ws) {
  const model = 'models/gemini-2.5-flash-preview-native-audio-dialog';
  const systemInstruction = {
    parts: [
      { text: 'You only answer about Revolt Motors. Politely decline other topics.' }
    ]
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

// WebSocket connection
wss.on('connection', async (ws) => {
  let session;
  try {
    session = await createLiveSession(ws);
    console.log("✅ Gemini session started");
  } catch (e) {
    ws.send(JSON.stringify({ type: 'fatal', error: String(e) }));
    ws.close();
    return;
  }

  ws.on('message', async (message) => {
    let obj;
    try {
      obj = JSON.parse(message.toString());
    } catch {
      console.warn("⚠️ Received non-JSON message, skipping...");
      return;
    }

    console.log("📥 WS message type:", obj.type);

    if (obj.type === 'audio') {
      // Validate before sending to Gemini
      if (
        !obj.data ||                       // null/undefined
        typeof obj.data !== 'string' ||    // must be base64
        obj.data.trim().length < 10        // too short to be valid
      ) {
        console.warn("⚠️ Skipping empty or invalid audio chunk");
        return;
      }

      console.log("🎤 Sending audio chunk to Gemini, length:", obj.data.length);

      try {
        await session.sendRealtimeInput({
          audio: { data: obj.data, mimeType: 'audio/pcm;rate=16000' }
        });
      } catch (err) {
        console.error("❌ Failed to send audio to Gemini:", err.message);
      }

    } else if (obj.type === 'activityEnd') {
      console.log("🛑 Activity ended by client");
      await session.sendRealtimeInput({ activityEnd: {} });

    } else if (obj.type === 'interrupt' || obj.type === 'stopPlayback') {
      console.log("⏹ Interruption command received");
      if (session.interrupt) await session.interrupt();
    }
  });

  ws.on('close', () => {
    console.log("🔌 WebSocket closed");
    session?.close();
  });
});

// Upgrade HTTP → WS
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => console.log(`🚀 Backend running at http://localhost:${PORT}`));
