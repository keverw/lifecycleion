import { reportCallbackError } from '../../safe-handle-callback';
import { toError } from '../../to-error';
import type {
  BroadcastOptions,
  BroadcastResult,
  GetValueOptions,
  MessageResult,
  SendMessageOptions,
  ValueResult,
} from '../types';
import {
  broadcastMessageInternal,
  getValueInternal,
  sendMessageInternal,
} from './component-messaging';
import type { ManagerCore } from './manager-core';
import { settleOperation } from './operation-policy';

/**
 * Messages, broadcasts and value reads under the public-method safety net (see
 * {@link settleOperation}), shared by the manager's public `sendMessageToComponent()`,
 * `broadcastMessage()` and `getValue()` and by each component's `lifecycle` handle, so a
 * request made from inside a component resolves the way one made from outside does. The
 * requests themselves are `component-messaging.ts`'s, over the access context.
 */
export class MessagingOperations {
  constructor(private readonly core: ManagerCore) {}

  /**
   * `sendMessageInternal()` under the public-method safety net (see
   * {@link settleOperation}). Shared by `sendMessageToComponent()` and the
   * component-scoped `ComponentLifecycle.sendMessageToComponent()`, so a message sent
   * from inside a component resolves the same way one sent from outside does.
   */
  public sendMessageSettled(
    componentName: string,
    payload: unknown,
    from: string | null,
    options?: SendMessageOptions,
  ): Promise<MessageResult> {
    return settleOperation(
      'sendMessageToComponent',
      () =>
        sendMessageInternal(
          this.core.componentAccess,
          componentName,
          payload,
          from,
          options,
        ),
      (error, _reason, code) => ({
        sent: false,
        componentFound: this.core.registry.isNameRegistered(componentName),
        componentRunning: this.core.state.runningComponents.has(componentName),
        handlerImplemented: false,
        data: undefined,
        error,
        timedOut: false,
        code,
      }),
    );
  }

  /**
   * `broadcastMessageInternal()` under the public-method safety net, shared the same way
   * as {@link sendMessageSettled}. The broadcast loop keeps the answers it collected when
   * it crashes partway. Invalid options - a bad timeout budget or a non-array
   * `componentNames` - refuse the whole broadcast with `[]` before announcing it, with a
   * warning rather than a callback-error report. Unexpected
   * failures before dispatch also answer `[]`, but remain reported on the global channel.
   */
  public broadcastMessageSettled(
    payload: unknown,
    from: string | null,
    options?: BroadcastOptions,
  ): Promise<BroadcastResult[]> {
    return settleOperation(
      'broadcastMessage',
      () =>
        broadcastMessageInternal(
          this.core.componentAccess,
          payload,
          from,
          options,
        ),
      (error, _reason, code) => {
        // The array contract has no aggregate error field. Keep its refusal shape,
        // but make invalid options (a bad timeout budget, a non-array `componentNames`)
        // visible through the configured logger instead of silently looking like an
        // empty recipient list. This is not a callback
        // crash and must not enter the global callback-error channel.
        if (code === 'invalid_options') {
          this.core.logger.warn('Broadcast refused: {{error.message}}', {
            params: { error },
          });
        }
        return [];
      },
    );
  }

  /**
   * `getValueInternal()` under a synchronous version of the public-method safety net
   * (see {@link settleOperation}): `getValue()` answers synchronously, so it gets a
   * `try`/`catch` rather than a settled promise, but the same promise - an unexpected
   * failure comes back as `code: 'operation_crashed'` with the original on `error`, and is reported
   * on the global `'error'` channel. Shared by `getValue()` and the component-scoped
   * `ComponentLifecycle.getValue()`.
   */
  public getValueSettled<T = unknown>(
    componentName: string,
    key: string,
    from: string | null,
    options?: GetValueOptions,
  ): ValueResult<T> {
    try {
      return getValueInternal<T>(
        this.core.componentAccess,
        componentName,
        key,
        from,
        options,
      );
    } catch (error) {
      reportCallbackError('lifecycle-manager getValue', error);

      return {
        found: false,
        value: undefined,
        componentFound: this.core.registry.isNameRegistered(componentName),
        componentRunning: this.core.state.runningComponents.has(componentName),
        handlerImplemented: false,
        requestedBy: from,
        code: 'operation_crashed',
        error: toError(error),
      };
    }
  }
}
