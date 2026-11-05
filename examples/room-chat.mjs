/** Compatibility entry for the shared continuous room client. */
import { roomChat } from '../src/room-client.mjs';

roomChat().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
