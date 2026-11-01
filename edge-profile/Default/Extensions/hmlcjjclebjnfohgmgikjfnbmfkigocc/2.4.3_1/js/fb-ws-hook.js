'use strict';

((window) => {
  // Minimal MQTT packet parser/generator (browser-native, no dependencies)
  const textDecoder = new TextDecoder();
  const textEncoder = new TextEncoder();

  const CMD_NAMES = [
    null, 'connect', 'connack', 'publish', 'puback',
    'pubrec', 'pubrel', 'pubcomp', 'subscribe', 'suback',
    'unsubscribe', 'unsuback', 'pingreq', 'pingresp', 'disconnect', 'auth'
  ];

  // Protocol names a CONNECT packet may carry (MQTT 3.1, 3.1.1, FB's MQTToT)
  const MQTT_PROTOCOL_NAMES = ['MQIsdp', 'MQTT', 'MQTToT'];

  // Set localStorage.j2ts_debug = '1' on facebook.com / messenger.com and
  // reload to log what this hook does. Must match DEBUG_FLAG_KEY in
  // src/constants/storage-keys.ts.
  const DEBUG = (() => {
    try {
      return window.localStorage.getItem('j2ts_debug') === '1';
    } catch (e) {
      return false;
    }
  })();
  const debugLog = DEBUG ? (...args) => console.debug('[J2TEAM Security] [WS]', ...args) : () => {};

  function decodeRemainingLength(data, startIndex) {
    let value = 0, multiplier = 1, index = startIndex, byte;
    do {
      if (index >= data.length) throw new Error('Incomplete remaining length');
      byte = data[index++];
      value += (byte & 0x7F) * multiplier;
      multiplier *= 128;
    } while (byte & 0x80);
    return { value, bytesRead: index - startIndex };
  }

  function encodeRemainingLength(length) {
    const bytes = [];
    do {
      let byte = length % 128;
      length = Math.floor(length / 128);
      if (length > 0) byte |= 0x80;
      bytes.push(byte);
    } while (length > 0);
    return bytes;
  }

  // Split a frame into MQTT packets. Throws if the frame is not well-formed
  // MQTT, so callers can fall back to sending the frame untouched.
  function parsePackets(data) {
    const packets = [];
    let pos = 0;

    while (pos < data.length) {
      const byte0 = data[pos];
      const typeNum = (byte0 >> 4) & 0x0F;
      if (typeNum === 0) throw new Error('Reserved packet type');

      const rl = decodeRemainingLength(data, pos + 1);
      const end = pos + 1 + rl.bytesRead + rl.value;
      if (end > data.length) throw new Error('Incomplete packet');

      const packet = { cmd: CMD_NAMES[typeNum], raw: data.subarray(pos, end) };
      let offset = pos + 1 + rl.bytesRead;

      if (typeNum === 3) { // PUBLISH
        packet.qos = (byte0 >> 1) & 0x03;
        packet.dup = !!(byte0 & 0x08);
        packet.retain = !!(byte0 & 0x01);

        // Topic: 2-byte length prefix + UTF-8 string
        const topicLen = (data[offset] << 8) | data[offset + 1];
        offset += 2;
        packet.topic = textDecoder.decode(data.subarray(offset, offset + topicLen));
        offset += topicLen;

        // Message ID: only if QoS > 0
        if (packet.qos > 0) {
          packet.messageId = (data[offset] << 8) | data[offset + 1];
          offset += 2;
        }

        packet.payload = data.subarray(offset, end);
      }

      packets.push(packet);
      pos = end;
    }

    return packets;
  }

  function generate(packet) {
    const qos = packet.qos || 0;
    const topicBytes = textEncoder.encode(packet.topic);

    let payloadBytes;
    if (packet.payload instanceof Uint8Array) {
      payloadBytes = packet.payload;
    } else if (typeof packet.payload === 'string') {
      payloadBytes = textEncoder.encode(packet.payload);
    } else {
      payloadBytes = new Uint8Array(0);
    }

    const hasMessageId = qos > 0;
    const remainingLength = 2 + topicBytes.length + (hasMessageId ? 2 : 0) + payloadBytes.length;
    const rlBytes = encodeRemainingLength(remainingLength);

    const byte0 = (3 << 4) |
      ((packet.dup ? 1 : 0) << 3) |
      ((qos & 0x03) << 1) |
      (packet.retain ? 1 : 0);

    const totalSize = 1 + rlBytes.length + remainingLength;
    const buffer = new Uint8Array(totalSize);
    let pos = 0;

    buffer[pos++] = byte0;
    for (let j = 0; j < rlBytes.length; j++) buffer[pos++] = rlBytes[j];

    // Topic length (big-endian) + topic string
    buffer[pos++] = (topicBytes.length >> 8) & 0xFF;
    buffer[pos++] = topicBytes.length & 0xFF;
    buffer.set(topicBytes, pos);
    pos += topicBytes.length;

    // Message ID (if QoS > 0)
    if (hasMessageId) {
      buffer[pos++] = (packet.messageId >> 8) & 0xFF;
      buffer[pos++] = packet.messageId & 0xFF;
    }

    // Payload
    buffer.set(payloadBytes, pos);

    return buffer;
  }

  // main
  // Must match OPTION_DEFAULTS in src/misc/config.ts. This hook runs at
  // document_start and applies these values until the async sync_settings
  // round-trip below returns the user's real settings — so defaulting to true
  // here would block seen/typing receipts for users who never enabled it.
  const settings = {
    block_seen_chat: false,
    block_typing_chat: false
  };

  // This hook runs on messenger.com as well as facebook.com, so the handshake
  // has to accept both. Matching on the parsed hostname rather than a substring
  // also stops origins like https://x.facebook.com.example.com from passing.
  // `new URL` throws on opaque origins ("null"), hence the guard.
  const TRUSTED_HOOK_HOSTS = ['.facebook.com', '.messenger.com'];

  function isTrustedHookOrigin(origin) {
    try {
      const hostname = new URL(origin).hostname;
      return TRUSTED_HOOK_HOSTS.some(
        (domain) => hostname === domain.slice(1) || hostname.endsWith(domain)
      );
    } catch (e) {
      return false;
    }
  }

  // handle message from extension
  window.addEventListener('message', (event) => {
    const data = event.data;

    if (
      event.isTrusted &&
      data &&
      isTrustedHookOrigin(event.origin) &&
      data.sender === 'j2team_security' &&
      data.cmd === 'sync_settings_response'
    ) {
      const options = data.data;

      if ('block_seen_chat' in options) {
        settings.block_seen_chat = options.block_seen_chat;
      }

      if ('block_typing_chat' in options) {
        settings.block_typing_chat = options.block_typing_chat;
      }

      debugLog('settings', { ...settings });
    }
  });

  // sync settings from extension
  window.postMessage({
    cmd: 'sync_settings',
    sender: 'facebook_content_script'
  });

  function getUserID() {
    const match = document.cookie.match(/c_user=([0-9]+)/);
    return match ? match[1] : null;
  }

  function safeParse(text) {
    if (!text) return null;
    try {
      return JSON.parse(text) || null;
    } catch (e) {
      return null;
    }
  }

  function toBytes(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
  }

  // Only the first frame a client sends on an MQTT socket is CONNECT, so this
  // tells Messenger's MQTT socket apart from FB's other sockets (e.g.
  // gateway.facebook.com/ws/streamcontroller), which use other protocols.
  function isMqttConnect(data) {
    const bytes = toBytes(data);
    if (!bytes || bytes.length < 4 || bytes[0] !== 0x10) return false;
    try {
      const rl = decodeRemainingLength(bytes, 1);
      const offset = 1 + rl.bytesRead;
      const nameLen = (bytes[offset] << 8) | bytes[offset + 1];
      const name = textDecoder.decode(bytes.subarray(offset + 2, offset + 2 + nameLen));
      return MQTT_PROTOCOL_NAMES.includes(name);
    } catch (e) {
      return false;
    }
  }

  // Returns the packet's bytes to send: the original, a rewritten copy, or
  // null to drop it.
  function rewritePacket(packet) {
    if (packet.cmd !== 'publish' || packet.topic !== '/ls_req' || !packet.payload) {
      return packet.raw;
    }

    const request = safeParse(textDecoder.decode(packet.payload));
    if (!request) return packet.raw;

    // block typing
    if (settings.block_typing_chat && request.type === 4) {
      const outer = safeParse(request.payload);
      const inner = outer && safeParse(outer.payload);
      if (inner && inner.thread_key) {
        debugLog('typing blocked');
        return null;
      }
    }

    // block seen: point every "mark thread read" task (label 21) at the user's
    // own thread so the real thread keeps its unread state for the sender
    const userId = getUserID();
    if (settings.block_seen_chat && request.type === 3 && userId) {
      const body = safeParse(request.payload);
      const tasks = body && Array.isArray(body.tasks) ? body.tasks : [];
      let changed = false;

      for (const task of tasks) {
        if (task && task.label === '21') {
          task.payload = JSON.stringify({
            thread_id: userId,
            last_read_watermark_ts: Date.now() * 1000
          });
          changed = true;
        }
      }

      if (changed) {
        debugLog('seen blocked');
        request.payload = JSON.stringify(body);
        return generate({ ...packet, payload: textEncoder.encode(JSON.stringify(request)) });
      }
    }

    return packet.raw;
  }

  // Returns what to hand to the native send(): the original data, a rewritten
  // ArrayBuffer, or null when every packet in the frame was dropped.
  function filterFrame(data) {
    if (!settings.block_seen_chat && !settings.block_typing_chat) return data;

    const bytes = toBytes(data);
    if (!bytes) return data;

    let packets;
    try {
      packets = parsePackets(bytes);
    } catch (e) {
      return data;
    }

    const parts = [];
    let changed = false;

    for (const packet of packets) {
      let out;
      try {
        out = rewritePacket(packet);
      } catch (e) {
        out = packet.raw;
      }
      if (out !== packet.raw) changed = true;
      if (out) parts.push(out);
    }

    if (!changed) return data;
    if (parts.length === 0) return null;

    const size = parts.reduce((sum, part) => sum + part.length, 0);
    const frame = new Uint8Array(size);
    let pos = 0;
    for (const part of parts) {
      frame.set(part, pos);
      pos += part.length;
    }
    return frame.buffer;
  }

  const wsProxy = new Proxy(window.WebSocket, {
    construct(target, args, newTarget) {
      const instance = Reflect.construct(target, args, newTarget);
      const nativeSend = instance.send;
      let isMqtt = null;

      instance.send = function (data) {
        if (isMqtt === null) {
          isMqtt = isMqttConnect(data);
          debugLog(isMqtt ? 'hooked MQTT socket' : 'ignored socket', String(args[0]).split('?')[0]);
          // Not MQTT: hand the socket back to the native send for good
          if (!isMqtt) delete instance.send;
        }

        if (!isMqtt) return nativeSend.call(this, data);

        const out = filterFrame(data);
        if (out === null) return;
        return nativeSend.call(this, out);
      };

      return instance;
    }
  });

  window.WebSocket = wsProxy;
})(window);
