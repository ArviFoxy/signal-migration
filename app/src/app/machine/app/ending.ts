// Ending: signing out of Telegram and unlinking Signal, at the end of the migration or for "Disconnect and clear".
// Each part has its time limits (signing out: telegram/signing-out.ts, unlinking: the request limit); the session's
// rules (settle.ts) move on once both have ended, or to end-failed once one of them failed.

import type { Context, VariantHandlers } from '../core';
import type { AppEvent } from '../events';
import type { AppState } from './state';

export const ending: VariantHandlers<AppState, 'ending', AppEvent, Context> = {};
