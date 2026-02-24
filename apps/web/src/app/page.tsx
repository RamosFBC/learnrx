"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { GoogleGenAI } from "@google/genai";
import { Mic, MicOff, Maximize, MousePointer2 } from "lucide-react";

const workletCode = `
class AudioProcessingWorklet extends AudioWorkletProcessor {
  buffer = new Int16Array(2048);
  bufferWriteIndex = 0;
  constructor() {
    super();
  }
  process(inputs) {
    if (inputs[0].length) {
      const channel0 = inputs[0][0];
      this.processChunk(channel0);
    }
    return true;
  }
  sendAndClearBuffer() {
    this.port.postMessage({
      event: 'chunk',
      data: {
        int16arrayBuffer: this.buffer.slice(0, this.bufferWriteIndex).buffer
      }
    });
    this.bufferWriteIndex = 0;
  }
  processChunk(float32Array) {
    const l = float32Array.length;
    for (let i = 0; i < l; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      this.buffer[this.bufferWriteIndex++] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      if(this.bufferWriteIndex >= this.buffer.length) {
        this.sendAndClearBuffer();
      }
    }
  }
}
registerProcessor('audio-recorder-worklet', AudioProcessingWorklet);
`;

function arrayBufferToBase64(buffer: ArrayBuffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

export default function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const aiRef = useRef<any>(null);
  const sessionRef = useRef<any>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nextPlayTimeRef = useRef(0);
  const pointerRef = useRef({ x: 0, y: 0 });
  const intervalRef = useRef<number | null>(null);



  useEffect(() => {
    // The Google Gen AI SDK has a hardcoded leading slash that forces a `//ws/` 
    // connection when combined with our baseUrl. Railway load balancers reject this.
    // We'll monkey-patch the native WebSocket to clean the URL before it connects.
    const OriginalWebSocket = window.WebSocket;
    class PatchedWebSocket extends OriginalWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        if (typeof url === 'string') {
          url = url.replace('//ws/google.ai', '/ws/google.ai');
        } else if (url instanceof URL) {
          url.href = url.href.replace('//ws/google.ai', '/ws/google.ai');
        }
        super(url, protocols);
      }
    }
    window.WebSocket = PatchedWebSocket as any;

    let proxyUrl = process.env.NEXT_PUBLIC_WS_PROXY_URL || "http://localhost:3001";
    proxyUrl = proxyUrl.replace(/\/+$/, "");
    console.log("[X-Ray Tutor] Using Proxy URL:", proxyUrl);

    // The proxy server injects the real API key. We just provide a dummy string to satisfy the SDK.
    aiRef.current = new GoogleGenAI({
      apiKey: "proxy-mode",
      httpOptions: {
        baseUrl: proxyUrl
      }
    });
  }, []);

  useEffect(() => {
    const draw = () => {
      const ctx = canvasRef.current?.getContext("2d");
      if (ctx && imgRef.current && imgRef.current.naturalWidth) {
        canvasRef.current!.width = imgRef.current.naturalWidth;
        canvasRef.current!.height = imgRef.current.naturalHeight;
        ctx.clearRect(0, 0, canvasRef.current!.width, canvasRef.current!.height);
        ctx.drawImage(imgRef.current, 0, 0, canvasRef.current!.width, canvasRef.current!.height);
        ctx.beginPath();
        ctx.arc(pointerRef.current.x, pointerRef.current.y, 8, 0, 2 * Math.PI);
        ctx.fillStyle = "rgba(0, 255, 0, 0.7)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 255, 255, 1)";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  }, []);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    pointerRef.current = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  };

  const playBase64Pcm = (base64: string) => {
    if (!audioCtxRef.current) return;
    const raw = window.atob(base64);
    const array = new Uint8Array(new ArrayBuffer(raw.length));
    for (let i = 0; i < raw.length; i++) { array[i] = raw.charCodeAt(i); }
    const int16Array = new Int16Array(array.buffer);
    const audioBuffer = audioCtxRef.current.createBuffer(1, int16Array.length, 24000);
    const channelData = audioBuffer.getChannelData(0);
    for (let i = 0; i < int16Array.length; ++i) { channelData[i] = int16Array[i] / 32768; }
    const source = audioCtxRef.current.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioCtxRef.current.destination);
    const playTime = Math.max(audioCtxRef.current.currentTime, nextPlayTimeRef.current);
    source.start(playTime);
    nextPlayTimeRef.current = playTime + audioBuffer.duration;
  };

  const startSession = async () => {
    if (!aiRef.current) return alert("Missing NEXT_PUBLIC_GEMINI_API_KEY in .env.local");

    const audioCtx = new AudioContext({ sampleRate: 16000 });
    audioCtxRef.current = audioCtx;
    nextPlayTimeRef.current = audioCtx.currentTime;

    try {
      setMessages((m) => [...m, "Connecting..."]);
      const session = await aiRef.current.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: ["AUDIO"],
          systemInstruction: { parts: [{ text: "You are an AI teaching assistant for radiology. The user will share a canvas with an X-Ray and a green dot representing their cursor. Guide them by asking them to point to specific structures, or if they ask 'what am I pointing at?', answer correctly based on the green dot's location." }] }
        },
        callbacks: {
          onopen: () => {
            setIsConnected(true);
            setMessages((m) => [...m, "Connected!"]);
          },
          onerror: (e: any) => {
            console.error(e);
            setMessages((m) => [...m, "Error: " + e.message]);
            stopSession();
          },
          onclose: (e: any) => {
            console.log("Session closed", e);
            stopSession();
          },
          onmessage: (msg: any) => {
            const parts = msg.serverContent?.modelTurn?.parts;
            if (parts) {
              for (const part of parts) {
                if (part.text) setMessages((m) => [...m, "AI: " + part.text]);
                if (part.inlineData?.data) playBase64Pcm(part.inlineData.data);
              }
            }
          }
        }
      });
      sessionRef.current = session;
      // session.sendClientContent({ turns: "Hello! I am ready to learn.", turnComplete: true });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const blob = new Blob([workletCode], { type: "application/javascript" });
      const workletUrl = URL.createObjectURL(blob);
      await audioCtx.audioWorklet.addModule(workletUrl);
      if (audioCtx.state === 'closed') return;
      const src = audioCtx.createMediaStreamSource(stream);
      const recordingWorklet = new AudioWorkletNode(audioCtx, "audio-recorder-worklet");
      recordingWorklet.port.onmessage = (ev) => {
        const arrayBuffer = ev.data.data.int16arrayBuffer;
        if (arrayBuffer && sessionRef.current) {
          const base64 = arrayBufferToBase64(arrayBuffer);
          sessionRef.current.sendRealtimeInput({
            media: { data: base64, mimeType: "audio/pcm;rate=16000" }
          });
        }
      };
      src.connect(recordingWorklet);
      intervalRef.current = window.setInterval(() => {
        if (canvasRef.current && sessionRef.current) {
          const dataUrl = canvasRef.current.toDataURL("image/jpeg", 0.3);
          const base64 = dataUrl.split(",")[1];
          sessionRef.current.sendRealtimeInput({
            media: { data: base64, mimeType: "image/jpeg" }
          });
        }
      }, 1000);
    } catch (err: any) {
      console.error(err);
      alert("Failed to connect: " + err.message);
    }
  };

  const stopSession = () => {
    setIsConnected(false);
    if (sessionRef.current) sessionRef.current = null;
    if (streamRef.current) streamRef.current.getTracks().forEach((track) => track.stop());
    if (audioCtxRef.current) audioCtxRef.current.close();
    if (intervalRef.current) clearInterval(intervalRef.current);
    setMessages((m) => [...m, "Disconnected."]);
  };

  return (
    <div className="flex h-screen w-full bg-slate-950 text-slate-200">
      <div className="flex-1 flex flex-col p-6 items-center justify-center relative">
        <h1 className="text-2xl font-bold text-white mb-4">X-Ray Tutor</h1>
        <div className="relative rounded-xl overflow-hidden border border-slate-700 shadow-xl bg-slate-900 cursor-crosshair">
          <img
            ref={imgRef}
            src="/xray.png"
            alt="X Ray Source"
            className="hidden"
          />
          <canvas
            ref={canvasRef}
            onMouseMove={handleMouseMove}
            className="w-full max-w-[600px] h-auto object-contain block"
          />
        </div>
      </div>
      <div className="w-[350px] bg-slate-900 border-l border-slate-800 p-6 flex flex-col">
        <div className="mb-6 flex space-x-2">
          {!isConnected ? (
            <button onClick={startSession} className="flex-1 flex justify-center items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white py-3 px-4 rounded-lg font-medium transition-colors">
              <Mic size={20} />
              Start Tutor Session
            </button>
          ) : (
            <button onClick={stopSession} className="flex-1 flex justify-center items-center gap-2 bg-red-600 hover:bg-red-500 text-white py-3 px-4 rounded-lg font-medium transition-colors">
              <MicOff size={20} />
              Stop Session
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto space-y-3 bg-slate-950 p-4 rounded-lg border border-slate-800 text-sm">
          {messages.length === 0 ? (
            <p className="text-slate-500 italic">No messages yet. Click start to connect to the Gemini tutor.</p>
          ) : (
            messages.map((msg, i) => <div key={i} className="text-slate-300">{msg}</div>)
          )}
        </div>
      </div>
    </div>
  );
}
