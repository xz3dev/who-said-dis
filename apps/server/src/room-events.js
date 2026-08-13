import { WebSocket } from "ws";

export class RoomEventHub {
  constructor(options = {}) {
    this.rooms = new Map();
    this.closing = false;
    this.keepAlive = setInterval(() => this.sendPings(), options.keepAliveMs || 20_000);
    this.keepAlive.unref?.();
  }

  subscribe(roomId, participantId, ip, socket, getState) {
    const subscribers = this.rooms.get(roomId) || new Set();
    const participantConnections = [...subscribers].filter(
      (subscriber) => subscriber.participantId === participantId
    );
    const ipConnections = [...this.rooms.values()]
      .flatMap((roomSubscribers) => [...roomSubscribers])
      .filter((subscriber) => subscriber.ip === ip);
    if (participantConnections.length >= 2 || ipConnections.length >= 50) return false;

    const subscriber = { participantId, ip, socket, getState, isAlive: true };
    subscribers.add(subscriber);
    this.rooms.set(roomId, subscribers);

    socket.on("pong", () => { subscriber.isAlive = true; });
    socket.on("error", () => {});
    let subscribed = true;
    const unsubscribe = () => {
      if (!subscribed) return;
      subscribed = false;
      subscribers.delete(subscriber);
      if (subscribers.size === 0) this.rooms.delete(roomId);
      if (!this.closing) this.publish(roomId);
    };
    socket.once("close", unsubscribe);

    this.publish(roomId);
    return true;
  }

  publish(roomId) {
    const subscribers = this.rooms.get(roomId) || [];
    const presentParticipantIds = new Set(
      [...subscribers].map((subscriber) => subscriber.participantId)
    );
    for (const subscriber of subscribers) this.sendState(subscriber, presentParticipantIds);
  }

  connectionCount(roomId) {
    return this.rooms.get(roomId)?.size || 0;
  }

  close() {
    this.closing = true;
    clearInterval(this.keepAlive);
    for (const subscribers of this.rooms.values()) {
      for (const { socket } of subscribers) socket.terminate();
    }
    this.rooms.clear();
  }

  sendState(subscriber, presentParticipantIds) {
    const state = subscriber.getState();
    if (!state || subscriber.socket.readyState !== WebSocket.OPEN) return;
    const room = {
      ...state,
      participants: state.participants.filter((participant) => presentParticipantIds.has(participant.id))
    };
    subscriber.socket.send(JSON.stringify({ type: "room_state", room }));
  }

  sendPings() {
    for (const subscribers of this.rooms.values()) {
      for (const subscriber of subscribers) {
        if (!subscriber.isAlive) {
          subscriber.socket.terminate();
          continue;
        }
        if (subscriber.socket.readyState === WebSocket.OPEN) {
          subscriber.isAlive = false;
          subscriber.socket.ping();
        }
      }
    }
  }
}
