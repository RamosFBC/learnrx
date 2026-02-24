import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables. In local dev, load from web app's .env.local
dotenv.config({ path: path.resolve(__dirname, '../../web/.env.local') });
dotenv.config(); // fallback

const app = express();
app.use(cors());

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
    const url = request.url || '';
    if (url.includes('/ws/google.ai.generativelanguage')) {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});

wss.on('connection', (clientWs, request) => {
    const apiKey = process.env.GEMINI_API_KEY || process.env.NEXT_PUBLIC_GEMINI_API_KEY;

    if (!apiKey) {
        console.error("Missing Gemini API Key in server environment variables.");
        clientWs.close(1008, "Missing API Key");
        return;
    }

    // Clean up any double slashes from the SDK's requested URL
    const cleanUrl = (request.url || '').replace(/^\/\//, '/');

    // Parse the connection URL sent by the client SDK
    const targetUrl = new URL(`wss://generativelanguage.googleapis.com${cleanUrl}`);

    // Inject the real server-side API key so the client doesn't need to know it
    targetUrl.searchParams.set('key', apiKey);

    console.log(`[Proxy] New connection to: ${targetUrl.pathname}`);

    // Establish connection to Gemini Live API
    const googleWs = new WebSocket(targetUrl.toString());

    // Queue for messages sent by the client before the Google WS is fully open
    const messageQueue: WebSocket.RawData[] = [];

    googleWs.on('open', () => {
        console.log(`[Proxy] Connected to Google Gemini Live API`);
        // Flush queued messages
        while (messageQueue.length > 0) {
            const msg = messageQueue.shift();
            if (msg) googleWs.send(msg);
        }
    });

    // Pipe data: Google -> Client
    googleWs.on('message', (data) => {
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(data);
        }
    });

    // Pipe data: Client -> Google
    clientWs.on('message', (data) => {
        if (googleWs.readyState === WebSocket.OPEN) {
            googleWs.send(data);
        } else {
            messageQueue.push(data);
        }
    });

    googleWs.on('close', (code, reason) => {
        console.log(`[Proxy] Google WS closed: ${code} - ${reason.toString()}`);
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(code, reason);
        }
    });

    clientWs.on('close', (code, reason) => {
        console.log(`[Proxy] Client WS closed: ${code} - ${reason.toString()}`);
        if (googleWs.readyState === WebSocket.OPEN) {
            googleWs.close(code, reason);
        }
    });

    googleWs.on('error', (err) => {
        console.error("[Proxy] Google WS Error:", err);
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(1011, "Google API Error");
        }
    });

    clientWs.on('error', (err) => {
        console.error("[Proxy] Client WS Error:", err);
        if (googleWs.readyState === WebSocket.OPEN) {
            googleWs.close(1011, "Client Error");
        }
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`\n=============================================`);
    console.log(`💎 Gemini Live API WebSocket Proxy Running`);
    console.log(`📡 URL: http://localhost:${PORT}`);
    console.log(`=============================================\n`);
});
