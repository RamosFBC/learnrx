import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

export async function POST() {
    try {
        // Note: In production you'd use a private GEMINI_API_KEY. We fallback to NEXT_PUBLIC_... if the private one isn't set yet during transition.
        const apiKey = process.env.GEMINI_API_KEY || process.env.NEXT_PUBLIC_GEMINI_API_KEY;
        if (!apiKey) {
            return NextResponse.json({ error: 'API key not configured' }, { status: 500 });
        }

        const ai = new GoogleGenAI({ apiKey, apiVersion: 'v1alpha' });

        // Create a 1-hour ephemeral token
        const expiration = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const response = await ai.authTokens.create({ config: { expireTime: expiration } });

        const rawToken = response.name?.replace('auth_tokens/', '') || '';

        return NextResponse.json({ token: rawToken });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
