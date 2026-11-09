import { fromBinary } from '@bufbuild/protobuf';
import { ProvisioningAddressSchema } from './gen/chat_provisioning_pb';
import { WebSocketMessage_Type, WebSocketMessageSchema } from './gen/chat_websocket_pb';

/** Signal's censorship-circumvention reflectors, from libsignal's rust/net/src/env.rs. */
export const REFLECTORS = ['reflector-nrgwuv7kwq-uc.a.run.app', 'reflector-signal.global.ssl.fastly.net'] as const;

export type ProvisioningResult = {
  reflector: string;
  opened: boolean;
  firstRequest?: string;
  addressLength?: number;
  error?: string;
};

/**
 * Opens the device-linking WebSocket through a reflector, reads the server's first request,
 * and closes. The reflector's "/service" path prefix routes to Signal's chat server.
 */
export function probeProvisioningSocket(reflector: string, timeoutMs = 15000): Promise<ProvisioningResult> {
  return new Promise((resolve) => {
    const result: ProvisioningResult = { reflector, opened: false };
    const socket = new WebSocket(`wss://${reflector}/service/v1/websocket/provisioning/`);
    socket.binaryType = 'arraybuffer';
    const finish = (error?: string) => {
      clearTimeout(timer);
      if (error !== undefined) result.error = error;
      socket.close();
      resolve(result);
    };
    const timer = setTimeout(() => finish(`no message within ${timeoutMs} ms`), timeoutMs);
    socket.onopen = () => {
      result.opened = true;
    };
    socket.onerror = () => finish('WebSocket error');
    socket.onmessage = (event) => {
      try {
        const message = fromBinary(WebSocketMessageSchema, new Uint8Array(event.data as ArrayBuffer));
        if (message.type !== WebSocketMessage_Type.REQUEST || message.request === undefined) {
          return finish('first message is not a request');
        }
        result.firstRequest = `${message.request.verb} ${message.request.path}`;
        result.addressLength = fromBinary(ProvisioningAddressSchema, message.request.body).address.length;
        finish();
      } catch (error) {
        finish(String(error));
      }
    };
  });
}
