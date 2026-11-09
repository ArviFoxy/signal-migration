// The Telegram login machine: the variants' handlers and work put together.

import { byVariant, type Context } from '../core';
import type { Work } from '../work';
import { creating, creatingWork } from './creating';
import { deletingHandlers, deletingWork } from './deleting';
import { endingByItself, endingByItselfWork } from './ending-by-itself';
import { login, loginWork } from './login';
import { off, offWork } from './off';
import { saving, savingWork } from './saving';
import { signedIn, signedInWork } from './signed-in';
import { signingOut, signingOutWork } from './signing-out';
import { starting, startingWork } from './starting';
import type { TelegramEvent, TelegramState } from './state';
import { stoppedHandlers, stoppedWork } from './stopped';

export * from './state';

export const telegramTransition: (state: TelegramState, event: TelegramEvent, context: Context) => TelegramState =
  byVariant<TelegramState, TelegramEvent, Context>({
    off,
    creating,
    starting,
    login,
    saving,
    'signed-in': signedIn,
    'signing-out': signingOut,
    'ending-by-itself': endingByItself,
    stopped: stoppedHandlers,
    deleting: deletingHandlers,
  });

export function telegramWork(state: TelegramState): Work[] {
  switch (state.kind) {
    case 'off':
      return offWork();
    case 'creating':
      return creatingWork();
    case 'starting':
      return startingWork(state);
    case 'login':
      return loginWork(state);
    case 'saving':
      return savingWork(state);
    case 'signed-in':
      return signedInWork(state);
    case 'signing-out':
      return signingOutWork(state);
    case 'ending-by-itself':
      return endingByItselfWork(state);
    case 'stopped':
      return stoppedWork();
    case 'deleting':
      return deletingWork(state);
  }
}

export const initialTelegram: TelegramState = { kind: 'off', method: 'qr', signedOut: false, error: null };
