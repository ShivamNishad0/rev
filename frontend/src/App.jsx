import React, { useState, useRef, useEffect } from 'react';

export default function App() {
  const [log, setLog] = useState([]);
  const [micOn, setMicOn] = useState(false);
  const wsRef = useRef(null);
  const audioCtxRef = useRef(null);
  const processorRef = useRef(null);
  const streamRef = useRef(null);
  const bufferRef = useRef([]);
  const lastSendRef = useRef(Date.now());

  const appendLog = (cls, text) => setLog(prev => [...prev, { cls, text }]);

  useEffect(() => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => appendLog('system', 'WS connected');
    ws.onmessage = evt => {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'ai_audio') handleAIaudio(msg.payload);
      else appendLog('system', `Server: ${msg.type}`);
    };
    wsRef.current = ws;
    return () => ws.close();
  }, []);

  function handleAIaudio({ data, sampleRate = 24000 }) {
    ensureAudioCtx();
    const int16 = base64ToInt16(data);
    const float32 = int16ToFloat32(int16);
    const buffer = audioCtxRef.current.createBuffer(1, float32.length, sampleRate);
    buffer.getChannelData(0).set(float32);
    const src = audioCtxRef.current.createBufferSource();
    src.buffer = buffer;
    src.connect(audioCtxRef.current.destination);
    src.start();
  }

  async function startMic() {
    ensureAudioCtx();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    const mediaSource = audioCtxRef.current.createMediaStreamSource(stream);
    const processor = audioCtxRef.current.createScriptProcessor(4096, 1, 1);
    processorRef.current = processor;
    mediaSource.connect(processor);
    processor.connect(audioCtxRef.current.destination);
    bufferRef.current = [];
    lastSendRef.current = Date.now();

    processor.onaudioprocess = e => {
      const float32 = e.inputBuffer.getChannelData(0);
      bufferRef.current.push(new Float32Array(float32));
      if (Date.now() - lastSendRef.current >= 250) {
        lastSendRef.current = Date.now();
        const full = flatten(bufferRef.current);
        bufferRef.current = [];
        const down = downsample(full, audioCtxRef.current.sampleRate, 16000);
        const pcm16 = floatTo16BitPCM(down);
        const b64 = base64FromInt16(pcm16);
        wsRef.current?.send(JSON.stringify({ type: 'audio', data: b64 }));
      }
    };

    setMicOn(true);
    appendLog('system', 'Mic started');
  }

  function stopMic() {
    processorRef.current?.disconnect();
    streamRef.current?.getTracks().forEach(t => t.stop());
    wsRef.current?.send(JSON.stringify({ type: 'activityEnd' }));
    setMicOn(false);
    appendLog('system', 'Mic stopped');
  }

  function ensureAudioCtx() {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
  }

  const base64ToInt16 = b64 => new Int16Array(base64ToArrayBuffer(b64));
  const base64ToArrayBuffer = b64 => {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  };
  const int16ToFloat32 = int16 => {
    const f32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 0x7fff;
    return f32;
  };
  const flatten = chunks => {
    let total = chunks.reduce((sum, c) => sum + c.length, 0);
    const res = new Float32Array(total);
    let offset = 0;
    for (let c of chunks) { res.set(c, offset); offset += c.length; }
    return res;
  };
  const downsample = (buffer, sr, outSr) => {
    if (sr === outSr) return buffer;
    const ratio = sr / outSr;
    const newLen = Math.round(buffer.length / ratio);
    const res = new Float32Array(newLen);
    let offsetRes = 0, offsetBuff = 0;
    while (offsetRes < res.length) {
      const nextOffsetBuff = Math.round((offsetRes + 1) * ratio);
      let acc = 0, cnt = 0;
      for (let i = offsetBuff; i < nextOffsetBuff; i++) { acc += buffer[i]; cnt++; }
      res[offsetRes] = cnt ? acc / cnt : 0;
      offsetRes++; offsetBuff = nextOffsetBuff;
    }
    return res;
  };
  const floatTo16BitPCM = f32 => {
    const i16 = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      let s = Math.max(-1, Math.min(1, f32[i]));
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return i16;
  };
  const base64FromInt16 = i16 => {
    const u8 = new Uint8Array(i16.buffer);
    let result = '';
    for (let i = 0; i < u8.length; i++) result += String.fromCharCode(u8[i]);
    return btoa(result);
  };

  return (
    <div style={{ maxWidth: 800, margin: '20px auto', fontFamily: 'sans-serif' }}>
      <h1>Revolt Motors Live Chat (React)</h1>
      <div style={{ border: '1px solid #ccc', height: 300, overflowY: 'auto', padding: 8, background: '#fafafa' }}>
        {log.map((l, i) => (
          <div key={i} style={{ color: l.cls === 'ai' ? 'green' : '#555' }}>{l.text}</div>
        ))}
      </div>
      {!micOn ? (
        <button onClick={startMic}>Start Mic</button>
      ) : (
        <button onClick={stopMic}>Stop Mic</button>
      )}
    </div>
  );
}
