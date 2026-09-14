export type AlpacaStreamStatus = 'disabled' | 'connecting' | 'authenticating' | 'connected' | 'error' | 'disconnected';

export interface AlpacaCredentials {
  keyId: string;
  secret: string;
}

export interface AlpacaLiveSnapshot {
  symbol: string;
  tradePrice: number | null;
  tradeSize: number | null;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  exchangeTrade: string | null;
  exchangeBid: string | null;
  exchangeAsk: string | null;
  marketTimestamp: string | null;
  receivedAt: number | null;
}

export const EMPTY_ALPACA_SNAPSHOT: AlpacaLiveSnapshot = {
  symbol: '',
  tradePrice: null,
  tradeSize: null,
  bid: null,
  ask: null,
  bidSize: null,
  askSize: null,
  exchangeTrade: null,
  exchangeBid: null,
  exchangeAsk: null,
  marketTimestamp: null,
  receivedAt: null,
};

interface AlpacaStreamOptions {
  symbol: string;
  credentials: AlpacaCredentials;
  onStatus: (status: AlpacaStreamStatus, message?: string) => void;
  onSnapshot: (snapshot: AlpacaLiveSnapshot) => void;
}

const STREAM_URL = 'wss://stream.data.alpaca.markets/v2/iex';
const RECONNECT_MS = 3000;

export const connectAlpacaIex = ({ symbol, credentials, onStatus, onSnapshot }: AlpacaStreamOptions) => {
  const upper = symbol.trim().toUpperCase();
  const keyId = credentials.keyId.trim();
  const secret = credentials.secret.trim();
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let closedByUser = false;
  let latest: AlpacaLiveSnapshot = { ...EMPTY_ALPACA_SNAPSHOT, symbol: upper };

  const clearReconnect = () => {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const send = (payload: unknown) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  };

  const scheduleReconnect = () => {
    clearReconnect();
    if (closedByUser) return;
    reconnectTimer = window.setTimeout(() => start(), RECONNECT_MS);
  };

  const start = () => {
    clearReconnect();
    if (!upper || !keyId || !secret) {
      onStatus('disabled', '尚未設定 Alpaca Key ID / Secret');
      return;
    }

    onStatus('connecting', '連線 Alpaca IEX WebSocket…');
    socket = new WebSocket(STREAM_URL);

    socket.onopen = () => onStatus('authenticating', 'WebSocket 已連線，等待認證…');

    socket.onmessage = event => {
      let messages: any[] = [];
      try {
        const parsed = JSON.parse(String(event.data));
        messages = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        return;
      }

      for (const msg of messages) {
        if (msg?.T === 'success' && msg?.msg === 'connected') {
          send({ action: 'auth', key: keyId, secret });
          continue;
        }
        if (msg?.T === 'success' && msg?.msg === 'authenticated') {
          send({ action: 'subscribe', trades: [upper], quotes: [upper] });
          continue;
        }
        if (msg?.T === 'subscription') {
          onStatus('connected', `Alpaca IEX 即時串流：${upper}`);
          continue;
        }
        if (msg?.T === 'error') {
          onStatus('error', `Alpaca ${msg?.code ?? ''}: ${msg?.msg ?? 'stream error'}`.trim());
          continue;
        }
        if (msg?.S !== upper) continue;

        if (msg?.T === 't') {
          latest = {
            ...latest,
            tradePrice: Number.isFinite(Number(msg.p)) ? Number(msg.p) : latest.tradePrice,
            tradeSize: Number.isFinite(Number(msg.s)) ? Number(msg.s) : latest.tradeSize,
            exchangeTrade: msg.x ?? latest.exchangeTrade,
            marketTimestamp: msg.t ?? latest.marketTimestamp,
            receivedAt: Date.now(),
          };
          onSnapshot(latest);
          continue;
        }

        if (msg?.T === 'q') {
          latest = {
            ...latest,
            bid: Number.isFinite(Number(msg.bp)) && Number(msg.bp) > 0 ? Number(msg.bp) : latest.bid,
            ask: Number.isFinite(Number(msg.ap)) && Number(msg.ap) > 0 ? Number(msg.ap) : latest.ask,
            bidSize: Number.isFinite(Number(msg.bs)) ? Number(msg.bs) : latest.bidSize,
            askSize: Number.isFinite(Number(msg.as)) ? Number(msg.as) : latest.askSize,
            exchangeBid: msg.bx ?? latest.exchangeBid,
            exchangeAsk: msg.ax ?? latest.exchangeAsk,
            marketTimestamp: msg.t ?? latest.marketTimestamp,
            receivedAt: Date.now(),
          };
          onSnapshot(latest);
        }
      }
    };

    socket.onerror = () => onStatus('error', 'Alpaca WebSocket 發生連線錯誤');

    socket.onclose = () => {
      socket = null;
      if (closedByUser) {
        onStatus('disconnected', 'Alpaca WebSocket 已關閉');
        return;
      }
      onStatus('disconnected', 'Alpaca WebSocket 中斷，3 秒後自動重連');
      scheduleReconnect();
    };
  };

  start();

  return () => {
    closedByUser = true;
    clearReconnect();
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close();
    socket = null;
  };
};
