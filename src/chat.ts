/** Join a server-hosted room; leaving the client does not dispose the room or its agents. */
import { roomChat } from './room-client.mjs';

void roomChat('chat').catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Chat client failed');
  process.exitCode = 1;
});
