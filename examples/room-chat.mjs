import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

async function chat() {
  const [roomId] = process.argv.slice(2);
  const token = process.env.ENGINE_TOKEN;
  if (!roomId || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(roomId) || !token) {
    throw new Error('Usage: ENGINE_TOKEN=<your-user-token> npm run room-chat -- <room-id> [ENGINE_URL defaults to http://127.0.0.1:3000]');
  }
  const base = new URL(process.env.ENGINE_URL ?? 'http://127.0.0.1:3000');
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const controller = new AbortController();
  const seen = new Set();
  const seenActivities = new Set();
  let cursor = 0;
  let stopping = false;
  const request = async (path, options = {}) => {
    const response = await fetch(new URL(path, base), { ...options, headers, signal: controller.signal });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const error = new Error(`${body.error?.code ?? response.status}: ${body.error?.message ?? 'Request failed'}`);
      error.code = body.error?.code;
      throw error;
    }
    return response;
  };
  const show = (message) => {
    if (seen.has(message.id)) return;
    seen.add(message.id);
    console.log(`${message.from}: ${message.text}`);
  };
  const showActivity = (activity) => {
    if (activity.status !== 'failed' || seenActivities.has(activity.id)) return;
    seenActivities.add(activity.id);
    console.error(`${activity.agentId}: ${activity.error.code}: ${activity.error.message}`);
  };
  const snapshot = async () => {
    const room = await (await request(`/rooms/${roomId}`)).json();
    for (const message of room.messages) show(message);
    for (const activity of room.activity) showActivity(activity);
    cursor = room.eventCursor;
  };
  const connect = () => request(`/rooms/${roomId}/events?after=${cursor}`);
  await snapshot();
  let response = await connect();
  console.log('Connected. Type a message or @agent-id command. /quit exits.');
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const stop = () => { stopping = true; controller.abort(); lines.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const follow = (async () => {
    while (!stopping) {
      try {
        let buffer = '';
        const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = frame.split('\n').find((line) => line.startsWith('data: '));
            if (!data) continue;
            const event = JSON.parse(data.slice(6));
            cursor = event.seq;
            if (event.type === 'message') show(event.message);
            if (event.type === 'activity') showActivity(event.activity);
            if (event.type === 'closed') { stop(); return; }
          }
        }
      } catch (error) {
        if (stopping) return;
        console.error(`Connection interrupted: ${error.message}`);
      }
      if (!stopping) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        while (!stopping) {
          try { response = await connect(); break; }
          catch (error) {
            if (stopping) return;
            if (error.code === 'EVENTS_EXPIRED') await snapshot();
            else console.error(`Reconnect failed: ${error.message}`);
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
      }
    }
  })();
  try {
    for await (const line of lines) {
      if (line.trim() === '/quit') break;
      if (!line.trim()) continue;
      try {
        await request(`/rooms/${roomId}/messages`, { method: 'POST', body: JSON.stringify({ text: line, clientId: randomUUID() }) });
      } catch (error) { if (!stopping) console.error(`Send failed: ${error.message}`); }
    }
  } finally {
    stop();
    await follow;
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

chat().catch((error) => { console.error(error.message); process.exitCode = 1; });
