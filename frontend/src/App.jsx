import { useRef } from "react";

export default function App() {
  const wsRef = useRef(null);
  const audioCtxRef = useRef(null);
  const bufferRef = useRef([]);
  const lastSendRef = useRef(Date.now());

  function downsampleBuffer(buffer, sampleRate, outSampleRate) {
    if (outSampleRate === sampleRate) return buffer;
    const ratio = sampleRate / outSampleRate;
    const newLength = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
      let accum = 0, count = 0;
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
        accum += buffer[i];
        count++;
      }
      result[offsetResult] = accum / count;
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }
    return result;
  }

  function floatTo16BitPCM(float32Array) {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);
    let offset = 0;
    for (let i = 0; i < float32Array.length; i++, offset += 2) {
      let s = Math.max(-1, Math.min(1, float32Array[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buffer;
  }

  function base64ArrayBuffer(arrayBuffer) {
    let binary = "";
    const bytes = new Uint8Array(arrayBuffer);
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      let chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  const startMic = async () => {
    wsRef.current = new WebSocket("ws://localhost:3000/ws");

    wsRef.current.onopen = async () => {
      console.log("WebSocket connected");

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioCtxRef.current = new AudioContext({ sampleRate: 48000 });

      // Ensure AudioContext starts
      await audioCtxRef.current.resume();

      const source = audioCtxRef.current.createMediaStreamSource(stream);
      const processor = audioCtxRef.current.createScriptProcessor(4096, 1, 1);

      processor.onaudioprocess = e => {
        const float32 = e.inputBuffer.getChannelData(0);
        bufferRef.current.push(new Float32Array(float32));

        if (Date.now() - lastSendRef.current >= 250) {
          lastSendRef.current = Date.now();

          const full = Float32Array.from(bufferRef.current.flat());
          bufferRef.current = [];

          const down = downsampleBuffer(full, audioCtxRef.current.sampleRate, 16000);
          const pcm16 = floatTo16BitPCM(down);
          const b64 = base64ArrayBuffer(pcm16);

          console.log(`🎤 Frontend chunk length: ${b64.length}`);

          if (b64.trim().length > 0) {
            wsRef.current.send(JSON.stringify({ type: "audio", data: b64 }));
          }
        }
      };

      source.connect(processor);
      processor.connect(audioCtxRef.current.destination);
    };
  };

  return (
    <div>
      <h1>Gemini Voice Test</h1>
      <button onClick={startMic}>Start Mic</button>
    </div>
  );
}
