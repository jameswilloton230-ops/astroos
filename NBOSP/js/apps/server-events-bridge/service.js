// SERVER EVENTS BRIDGE — server-events-bridge.js
//
// Subscribes to the Node-side event stream (server/events-routes.js) and
// forwards each entry into the browser-side EventLog via ingestRemote(),
// so security/email/proxy activity from the server process shows up in
// the same Events app timeline as browser-origin events.
//
// Node-side events arrive with a delay relative to in-process browser
// events (an HTTP round trip vs. a direct function call) — expected, not
// a bug, given NW.js keeps Node and the renderer as separate contexts.
//
// Reconnects with backoff on drop (server restart, network blip) rather
// than giving up after one failure, since this is meant to run for the
// life of the OS session.

const ServerEventsBridge = {
  _source: null,
  _retryMs: 1000,
  _maxRetryMs: 30000,

  start() {
    if (ServerEventsBridge._source) return; // already running
    ServerEventsBridge._connect();
  },

  _connect() {
    let es;
    try {
      es = new EventSource('/api/events/stream');
    } catch (e) {
      console.error('[ServerEventsBridge] EventSource construction failed:', e.message);
      ServerEventsBridge._scheduleReconnect();
      return;
    }
    ServerEventsBridge._source = es;
    console.log('[ServerEventsBridge] Connecting to /api/events/stream...');

    es.onopen = () => {
      ServerEventsBridge._retryMs = 1000;
      console.log('[ServerEventsBridge] Connected');
    };

    es.onmessage = (evt) => {
      try {
        const entry = JSON.parse(evt.data);
        console.log('[ServerEventsBridge] Received:', entry.app, entry.message);
        if (typeof window.EventLog?.ingestRemote === 'function') {
          window.EventLog.ingestRemote(entry);
        }
      } catch (e) {
        console.error('[ServerEventsBridge] Malformed frame:', e.message);
      }
    };

    es.onerror = () => {
      console.warn('[ServerEventsBridge] Connection error, scheduling reconnect...');
      es.close();
      ServerEventsBridge._source = null;
      ServerEventsBridge._scheduleReconnect();
    };
  },

  _scheduleReconnect() {
    setTimeout(() => {
      ServerEventsBridge._connect();
    }, ServerEventsBridge._retryMs);
    ServerEventsBridge._retryMs = Math.min(ServerEventsBridge._retryMs * 2, ServerEventsBridge._maxRetryMs);
  },
};

ServerEventsBridge.start();

if (typeof window !== 'undefined') {
  window.ServerEventsBridge = ServerEventsBridge;
}
