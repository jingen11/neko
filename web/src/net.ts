import type { ClientMessage, ServerMessage } from "../../shared/protocol.ts";

/** WebSocket connection to the neko server, with automatic reconnect. */
export class Net {
  private ws?: WebSocket;
  private retry = 0;

  constructor(
    private handlers: {
      message: (msg: ServerMessage) => void;
      audio: (frame: ArrayBuffer) => void;
      status: (connected: boolean) => void;
    },
  ) {}

  connect() {
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.handlers.status(true);
      this.send({ type: "hello", client: "web", deviceId: deviceId(), audioRate: 24000 });
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") this.handlers.message(JSON.parse(ev.data));
      else this.handlers.audio(ev.data as ArrayBuffer);
    };
    ws.onclose = () => {
      this.handlers.status(false);
      const delay = Math.min(10_000, 1000 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  sendAudio(pcm: Int16Array<ArrayBuffer>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(pcm);
  }
}

/** A stable id for this browser (falls back to a per-session id if storage is blocked). */
function deviceId(): string {
  const fresh = "web-" + Math.random().toString(36).slice(2, 10);
  try {
    let id = localStorage.getItem("neko.deviceId");
    if (!id) localStorage.setItem("neko.deviceId", (id = fresh));
    return id;
  } catch {
    return fresh;
  }
}
