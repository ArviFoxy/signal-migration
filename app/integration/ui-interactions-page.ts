// Browser harness for real-Chrome UI interaction tests (integration/ui-interactions.test.ts).
// Mounts the real Lit components and drives DOM events (autofill, form submission, auth transitions, pointer events,
// popovers, toast dismissal) so every UI bug is reproduced and verified in an actual browser engine.

import type * as Td from 'tdlib-types';
import type { AppState, SetupStep } from '../src/app/machine/app';
import { EMPTY_STICKER_PROGRESS } from '../src/app/machine/record';
import type { Session } from '../src/app/machine/app/state';
import type { SignalState } from '../src/app/machine/signal';
import type { TelegramState } from '../src/app/machine/telegram';
import type { AppServices, StoredDevice } from '../src/app/services';
import { Workflow } from '../src/app/workflow';
import type { SavedMessage } from '../src/kinds/saved/messages';
import '../src/kinds/saved/ui/saved-step';
import type { SavedStep } from '../src/kinds/saved/ui/saved-step';
import '../src/kinds/stickers/ui/packs-step';
import type { StickerPacksStep } from '../src/kinds/stickers/ui/packs-step';
import '../src/ui/migrate-step';
import type { MigrateStep } from '../src/ui/migrate-step';
import '../src/ui/migration-app';
import type { MigrationApp } from '../src/ui/migration-app';
import '../src/ui/phone-input';
import type { PhoneInput } from '../src/ui/phone-input';
import '../src/ui/telegram-step';
import type { TelegramStep } from '../src/ui/telegram-step';

const device: StoredDevice = { aci: 'ui-test', deviceId: 3, password: '', storageServiceKey: new Uint8Array(32) };
const deviceKey = 'ui-test:3:0';
const signedIn: TelegramState = { kind: 'signed-in', method: 'qr', instance: 'ui-1', attempt: 1, error: null };
const linked: SignalState = {
  kind: 'linked',
  deviceName: 'Sticker migration',
  deviceKey,
  device,
  error: null,
  unlinks: 0,
};
const notConnected: TelegramState = { kind: 'off', method: 'qr', signedOut: false, error: null };
const notLinked: SignalState = {
  kind: 'off',
  deviceName: 'Sticker migration',
  unlinked: null,
  error: null,
  attempts: 0,
};

const session = (parts: Partial<Session> = {}): Session => ({
  telegram: notConnected,
  signal: notLinked,
  chosen: { stickers: true, friends: false, saved: false },
  packs: { kind: 'none' },
  deselected: [],
  stickerProgress: EMPTY_STICKER_PROGRESS,
  friends: { kind: 'none' },
  tickedFriends: [],
  friendsAdded: null,
  saved: { kind: 'none' },
  savedFrom: null,
  savedSentUpTo: null,
  savedDone: null,
  notice: null,
  ...parts,
});

const setup = (step: SetupStep, parts: Partial<Session> = {}): AppState => ({ ...session(parts), kind: 'setup', step });

const fakeServices = {} as AppServices;

const tick = async () => {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
};

function clearBody(): HTMLElement {
  document.body.innerHTML = '';
  const host = document.createElement('div');
  document.body.appendChild(host);
  return host;
}

function makeWorkflow(initial: AppState): { workflow: Workflow; events: unknown[] } {
  const workflow = new Workflow(fakeServices);
  const events: unknown[] = [];
  workflow.state = initial;
  const origDispatch = workflow.dispatch.bind(workflow);
  workflow.dispatch = (event) => {
    events.push(event);
    origDispatch(event);
  };
  return { workflow, events };
}

const uiTests = {
  async phoneInputAutofill() {
    const host = clearBody();
    const el = document.createElement('phone-input') as PhoneInput;
    const emitted: (string | null)[] = [];
    el.addEventListener('phone', (event) => emitted.push((event as CustomEvent<string | null>).detail));
    host.appendChild(el);
    await el.updateComplete;
    const input = el.querySelector('input[type="tel"]') as HTMLInputElement;
    input.value = '+1 201 555 0123';
    // Plain Event (not InputEvent): inputType is undefined, matching browser autofill.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await el.updateComplete;
    return { value: el.value, emitted };
  },

  async telegramPasswordPreservesWhitespace() {
    const host = clearBody();
    const { workflow, events } = makeWorkflow(
      setup('telegram', {
        telegram: {
          kind: 'login',
          method: 'phone',
          instance: 'ui-1',
          attempt: 1,
          auth: {
            _: 'authorizationStateWaitPassword',
            password_hint: '',
            has_recovery_email_address: false,
            has_passport_data: false,
            recovery_email_address_pattern: '',
          } as Td.AuthorizationState,
          request: null,
          sent: 1,
          qrRequested: false,
          error: null,
        },
      }),
    );
    const el = document.createElement('telegram-step') as TelegramStep;
    el.login = workflow.telegram;
    host.appendChild(el);
    await el.updateComplete;
    const input = el.querySelector('input') as HTMLInputElement;
    input.value = '  padded pass  ';
    const form = el.querySelector('form') as HTMLFormElement;
    form.requestSubmit();
    await el.updateComplete;
    return { events };
  },

  async telegramCodeToEmailClearsInput() {
    const host = clearBody();
    const { workflow } = makeWorkflow(
      setup('telegram', {
        telegram: {
          kind: 'login',
          method: 'phone',
          instance: 'ui-1',
          attempt: 1,
          auth: {
            _: 'authorizationStateWaitCode',
            code_info: { _: 'authenticationCodeInfo', phone_number: '+1 201 555 0123', timeout: 0 },
          } as Td.AuthorizationState,
          request: null,
          sent: 1,
          qrRequested: false,
          error: null,
        },
      }),
    );
    const el = document.createElement('telegram-step') as TelegramStep;
    el.login = workflow.telegram;
    host.appendChild(el);
    await el.updateComplete;
    const smsInput = el.querySelector('input') as HTMLInputElement;
    smsInput.value = '12345';

    // Transition to WaitEmailCode.
    workflow.state = setup('telegram', {
      telegram: {
        kind: 'login',
        method: 'phone',
        instance: 'ui-1',
        attempt: 1,
        auth: {
          _: 'authorizationStateWaitEmailCode',
          code_info: { _: 'emailAddressAuthenticationCodeInfo', email_address_pattern: 'u***@e***', length: 6 },
        } as Td.AuthorizationState,
        request: null,
        sent: 2,
        qrRequested: false,
        error: null,
      },
    });
    workflow.dispatchEvent(new Event('change'));
    await el.updateComplete;
    const emailInput = el.querySelector('input') as HTMLInputElement;
    return { emailInputValue: emailInput.value };
  },

  async telegramQrErrorHasRetryButton() {
    const host = clearBody();
    const { workflow, events } = makeWorkflow(
      setup('telegram', {
        telegram: {
          kind: 'login',
          method: 'qr',
          instance: 'ui-1',
          attempt: 1,
          auth: { _: 'authorizationStateWaitPhoneNumber' },
          request: null,
          sent: 1,
          qrRequested: true,
          error: 'NETWORK_ERROR',
        },
      }),
    );
    const el = document.createElement('telegram-step') as TelegramStep;
    el.login = workflow.telegram;
    host.appendChild(el);
    await el.updateComplete;
    const retryBtn = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Try again');
    retryBtn?.click();
    await el.updateComplete;
    return {
      hasRetryButton: Boolean(retryBtn),
      dispatchedRetry: events.some((e) => (e as { type?: string }).type === 'telegram/retry'),
    };
  },

  async telegramSwitchDisabledWhileSending() {
    const host = clearBody();
    const { workflow } = makeWorkflow(
      setup('telegram', {
        telegram: {
          kind: 'login',
          method: 'phone',
          instance: 'ui-1',
          attempt: 1,
          auth: { _: 'authorizationStateWaitPhoneNumber' },
          request: { _: 'setAuthenticationPhoneNumber', phone_number: '+12015550123' },
          sent: 1,
          qrRequested: false,
          error: null,
        },
      }),
    );
    const el = document.createElement('telegram-step') as TelegramStep;
    el.login = workflow.telegram;
    host.appendChild(el);
    await el.updateComplete;
    const toQrBtn = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('QR code instead'));
    const phoneToQrDisabled = Boolean(toQrBtn?.disabled);

    // Also test QR mode while another request is sending (rare, e.g. non-QR request).
    workflow.state = setup('telegram', {
      telegram: {
        kind: 'login',
        method: 'qr',
        instance: 'ui-1',
        attempt: 1,
        auth: { _: 'authorizationStateWaitOtherDeviceConfirmation', link: 'tg://login?token=x' },
        request: { _: 'checkAuthenticationCode', code: '1' },
        sent: 2,
        qrRequested: true,
        error: null,
      },
    });
    workflow.dispatchEvent(new Event('change'));
    await el.updateComplete;
    const toPhoneBtn = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('phone number instead'));
    const qrToPhoneDisabled = Boolean(toPhoneBtn?.disabled);
    return { phoneToQrDisabled, qrToPhoneDisabled };
  },

  async savedStepIgnoresRightClick() {
    const host = clearBody();
    const messages: SavedMessage[] = [
      { id: 1, date: Date.UTC(2024, 0, 1) / 1000, kind: 'text', body: 'first', styles: [] },
      { id: 2, date: Date.UTC(2024, 5, 1) / 1000, kind: 'text', body: 'second', styles: [] },
    ];
    const el = document.createElement('saved-step') as SavedStep;
    el.saved = { kind: 'read', instance: 'ui-1', attempt: 1, messages };
    el.from = null;
    const committed: (number | null)[] = [];
    el.addEventListener('copy-from', (event) =>
      committed.push((event as CustomEvent<{ from: number | null }>).detail.from),
    );
    host.appendChild(el);
    await el.updateComplete;
    const stage = el.querySelector('[data-timeline-stage]') as HTMLElement;
    const rect = stage.getBoundingClientRect();
    const x = rect.left + rect.width * 0.7;
    const y = rect.top + rect.height * 0.5;
    stage.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 2,
        buttons: 2,
        clientX: x,
        clientY: y,
      }),
    );
    stage.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 2,
        buttons: 0,
        clientX: x,
        clientY: y,
      }),
    );
    await el.updateComplete;
    return { committed };
  },

  async packsStepShowsReadingProgress() {
    const host = clearBody();
    const el = document.createElement('sticker-packs-step') as StickerPacksStep;
    el.packs = { kind: 'reading', instance: 'ui-1', attempt: 1, progress: { done: 3, total: 10 } };
    el.migration = null;
    host.appendChild(el);
    await el.updateComplete;
    const bar = el.querySelector('[role="progressbar"]');
    return {
      hasProgressBar: Boolean(bar),
      text: el.textContent ?? '',
    };
  },

  async migrateStepFinishedWithoutMigrationHasStartOver() {
    const host = clearBody();
    const el = document.createElement('migrate-step') as MigrateStep;
    el.stickers = true;
    el.migration = null;
    el.run = { ended: true, completed: true, canRetry: false, failed: false, ending: false, finished: true };
    host.appendChild(el);
    await el.updateComplete;
    const buttons = [...el.querySelectorAll('button')].map((b) => b.textContent?.trim());
    return { buttons };
  },

  async migrateStepWithoutPacksFailedHasBackTryAgainFinish() {
    const host = clearBody();
    const el = document.createElement('migrate-step') as MigrateStep;
    el.stickers = false;
    el.migration = null;
    el.run = { ended: true, completed: false, canRetry: true, failed: true, ending: false, finished: false };
    host.appendChild(el);
    await el.updateComplete;
    const buttons = [...el.querySelectorAll('button')].map((b) => b.textContent?.trim());
    return { buttons };
  },

  async migrateStepShowsLookingForFriends() {
    const host = clearBody();
    const { workflow } = makeWorkflow({
      ...session({
        telegram: signedIn,
        signal: linked,
        chosen: { stickers: false, friends: true, saved: false },
        friends: {
          kind: 'looking',
          instance: 'ui-1',
          deviceKey,
          attempt: 1,
          progress: null,
        },
      }),
      kind: 'migrating',
      run: { attempt: 1, status: 'running', error: null },
    });
    const app = document.createElement('migration-app') as MigrationApp;
    app.workflow = workflow;
    host.appendChild(app);
    await app.updateComplete;
    await tick();
    const friendsSection = app.querySelector('section[aria-label="Friends"]');
    return { text: friendsSection?.textContent?.trim() ?? '' };
  },

  async migrationAppDismissHidesNonDismissibleErrorToast() {
    const host = clearBody();
    const { workflow } = makeWorkflow(
      setup('packs', {
        telegram: signedIn,
        signal: linked,
        packs: { kind: 'failed', instance: 'ui-1', attempt: 1, error: 'Reading packs failed: network down' },
      }),
    );
    const app = document.createElement('migration-app') as MigrationApp;
    app.workflow = workflow;
    host.appendChild(app);
    await app.updateComplete;
    await tick();
    const toastBefore = app.querySelector('[role="alert"]');
    const dismissBtn = toastBefore?.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement | null;
    dismissBtn?.click();
    await app.updateComplete;
    await tick();
    const toastAfter = app.querySelector('[role="alert"]');
    return {
      hadToastBefore: Boolean(toastBefore),
      hasToastAfter: Boolean(toastAfter),
    };
  },

  async mobileConnectionsSheetBehavior() {
    const host = clearBody();
    const { workflow } = makeWorkflow(
      setup('packs', {
        telegram: signedIn,
        signal: linked,
      }),
    );
    const app = document.createElement('migration-app') as MigrationApp;
    app.workflow = workflow;
    host.appendChild(app);
    await app.updateComplete;
    await tick();

    // Check only one clear-everything confirmation popover exists and it is not nested inside connections-sheet.
    const sheet = app.querySelector('#connections-sheet') as HTMLElement;
    const clearPopovers = [...app.querySelectorAll('[id^="clear-everything"]')];
    const nestedClearPopover = Boolean(sheet.querySelector('[id^="clear-everything"]'));

    // Open mobile connections-sheet.
    const openBtn = [...app.querySelectorAll<HTMLButtonElement>('header button')].find(
      (b) => b.textContent?.trim() === 'Connections',
    );
    openBtn?.click();
    await tick();
    const openBefore = sheet.matches(':popover-open');

    // Click the (i) info button on Signal (middle row) and Sticker pack index (bottom row) inside the sheet.
    const signalInfoBtn = sheet.querySelector('button[aria-label="About the Signal connection"]') as HTMLButtonElement;
    signalInfoBtn.click();
    await app.updateComplete;
    await tick();
    const sheetRect = sheet.getBoundingClientRect();
    const signalCard = sheet.querySelector('#connection-info-below-signal') as HTMLElement | null;
    const cardStyle = signalCard ? getComputedStyle(signalCard) : null;
    const cardVisible = Boolean(
      signalCard &&
      cardStyle &&
      cardStyle.display !== 'none' &&
      cardStyle.visibility !== 'hidden' &&
      Number(cardStyle.opacity) > 0,
    );
    const cardRect = signalCard?.getBoundingClientRect() ?? null;
    const cardFitsHorizontally = Boolean(cardRect && cardRect.left >= 0 && cardRect.right <= window.innerWidth + 1);
    const sheetFitsViewport = sheetRect.top >= 0 && sheetRect.bottom <= window.innerHeight + 1;

    // Click Sign out inside connections-sheet: sheet must close!
    const signOutBtn = [...sheet.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Sign out');
    signOutBtn?.click();
    await app.updateComplete;
    await tick();
    const openAfterSignOut = sheet.matches(':popover-open');

    return {
      clearPopoverCount: clearPopovers.length,
      nestedClearPopover,
      openBefore,
      cardVisible,
      cardFitsHorizontally,
      sheetFitsViewport,
      openAfterSignOut,
    };
  },

  async migrateStepSavedRateLimitAndFailure() {
    const host = clearBody();
    const el = document.createElement('migrate-step') as MigrateStep;
    el.stickers = false;
    el.migration = null;
    el.run = { ended: false, completed: false, canRetry: false, failed: false, ending: false, finished: false };

    // 1. Actively copying: progress bar must be animated (data-state="active" + .progress-fill-active).
    el.saved = { kind: 'ready', toCopy: 388, copied: 97, wait: null };
    host.appendChild(el);
    await el.updateComplete;
    const activeBar = el.querySelector('section[aria-label="Saved Messages"] [role="progressbar"]') as HTMLElement;
    const activeFill = activeBar.firstElementChild as HTMLElement;
    const activeState = activeBar.dataset.state;
    const activeAnimated = activeFill.classList.contains('progress-fill-active');

    // 2. Signal rate-limited: still amber progress bar (no active animation) + hourglass + countdown.
    el.saved = {
      kind: 'ready',
      toCopy: 388,
      copied: 97,
      wait: { service: 'Signal', until: Date.now() + 45_000 },
    };
    await el.updateComplete;
    const savedSection = el.querySelector('section[aria-label="Saved Messages"]') as HTMLElement;
    const throttledBar = savedSection.querySelector('[role="progressbar"]') as HTMLElement;
    const throttledFill = throttledBar.firstElementChild as HTMLElement;
    const throttledState = throttledBar.dataset.state;
    const throttledAnimated = throttledFill.classList.contains('progress-fill-active');
    const throttledHasHourglass = Boolean(savedSection.querySelector('svg'));
    const rateLimitText = savedSection.textContent?.trim() ?? '';

    // 3. Telegram internal download throttle (unknown duration).
    el.saved = {
      kind: 'ready',
      toCopy: 388,
      copied: 97,
      wait: { service: 'Telegram', until: null },
    };
    await el.updateComplete;
    const telegramSlowText = savedSection.textContent?.trim() ?? '';

    // 4. Failed run: still failed bar + Stopped message.
    el.saved = { kind: 'ready', toCopy: 388, copied: 97, wait: null };
    el.run = { ended: true, completed: false, canRetry: true, failed: true, ending: false, finished: false };
    await el.updateComplete;
    const failedBar = savedSection.querySelector('[role="progressbar"]') as HTMLElement;
    const failedState = failedBar.dataset.state;
    const failedText = savedSection.textContent?.trim() ?? '';
    return {
      activeState,
      activeAnimated,
      throttledState,
      throttledAnimated,
      throttledHasHourglass,
      rateLimitText,
      telegramSlowText,
      failedState,
      failedText,
    };
  },

  async desktopSidebarAnchorsBottomOnShortViewport() {
    const host = clearBody();
    const { workflow } = makeWorkflow({
      ...session({
        telegram: signedIn,
        signal: linked,
        chosen: { stickers: true, friends: true, saved: true },
      }),
      kind: 'migrating',
      run: { attempt: 1, status: 'running', error: null },
    });
    const app = document.createElement('migration-app') as MigrationApp;
    app.workflow = workflow;
    app.build = {
      kind: 'verified',
      tag: 'v0.3.1',
      commit: '25863eb',
      url: 'https://github.com/example/repo/attestations',
    };
    host.appendChild(app);
    await app.updateComplete;
    await tick();

    const nav = app.querySelector('nav') as HTMLElement;
    const ol = nav.querySelector('ol') as HTMLElement;
    const navRect = nav.getBoundingClientRect();
    const navStyle = getComputedStyle(nav);
    const olStyle = getComputedStyle(ol);

    const verifiedLink = [...nav.querySelectorAll('a')].find((a) => a.textContent?.includes('Verified build'))!;
    const githubLink = [...nav.querySelectorAll('a')].find((a) => a.textContent?.includes('Source code on GitHub'))!;
    const clearBtn = [...nav.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Disconnect and clear local state'),
    )!;

    const verifiedRect = verifiedLink.getBoundingClientRect();
    const githubRect = githubLink.getBoundingClientRect();
    const clearRect = clearBtn.getBoundingClientRect();

    // Reveal the top (Telegram) and middle (Signal) side tooltips as hover does and verify hit-testing outside nav's
    // right edge proves nav does not clip either floating tooltip, and neither overflows the top of the viewport.
    const signalCard = nav.querySelector('#connection-info-side-signal') as HTMLElement;
    Object.assign(signalCard.style, { visibility: 'visible', opacity: '1' });
    await tick();
    const signalRect = signalCard.getBoundingClientRect();
    const signalHit = document.elementFromPoint(navRect.right + 40, signalRect.top + signalRect.height / 2);
    Object.assign(signalCard.style, { visibility: '', opacity: '' });

    const telegramCard = nav.querySelector('#connection-info-side-telegram') as HTMLElement;
    Object.assign(telegramCard.style, { visibility: 'visible', opacity: '1' });
    await tick();
    const telegramRect = telegramCard.getBoundingClientRect();
    const telegramHit = document.elementFromPoint(navRect.right + 40, telegramRect.top + telegramRect.height / 2);
    Object.assign(telegramCard.style, { visibility: '', opacity: '' });

    // Also verify migrate-step places Friends, Saved Messages, and Sticker packs as direct siblings at the same
    // nesting level inside <main>.
    const sections = ['Friends', 'Saved Messages', 'Sticker packs'].map((label) =>
      app.querySelector(`main section[aria-label="${label}"]`),
    );
    const sameParent =
      sections.every(Boolean) &&
      sections[0]!.parentElement === sections[1]!.parentElement &&
      sections[1]!.parentElement === sections[2]!.parentElement;

    // Transition from migrating -> done (workflow.step stays 'migrate', currentEntry moves to "Done and logged out")
    // and verify the sidebar <ol> scrolls "Done and logged out" into view automatically.
    workflow.state = {
      ...session({
        telegram: { kind: 'off', method: 'qr', signedOut: true, error: null },
        signal: { ...notLinked, unlinked: 'at-finish' },
        chosen: { stickers: true, friends: true, saved: true },
      }),
      kind: 'done',
    };
    workflow.dispatchEvent(new Event('change'));
    await app.updateComplete;
    await tick();
    const olRect = ol.getBoundingClientRect();
    const doneItem = ol.querySelector('li[aria-current="step"]') as HTMLElement;
    const doneRect = doneItem.getBoundingClientRect();

    return {
      viewportHeight: window.innerHeight,
      navBottom: navRect.bottom,
      navOverflowY: navStyle.overflowY,
      navOverflowX: navStyle.overflowX,
      olOverflowY: olStyle.overflowY,
      olScrollHeight: ol.scrollHeight,
      olClientHeight: ol.clientHeight,
      verifiedBottom: verifiedRect.bottom,
      githubBottom: githubRect.bottom,
      clearBottom: clearRect.bottom,
      sideCardHit: Boolean(signalHit && signalCard.contains(signalHit)),
      sideCardRight: signalRect.right,
      navRight: navRect.right,
      sideCardTop: signalRect.top,
      sideCardBottom: signalRect.bottom,
      telegramCardHit: Boolean(telegramHit && telegramCard.contains(telegramHit)),
      telegramCardTop: telegramRect.top,
      sameParent,
      doneVisibleInOl: doneRect.top >= olRect.top - 1 && doneRect.bottom <= olRect.bottom + 1,
    };
  },

  async migrateCopyAndPersistedCompletedCards() {
    const host = clearBody();
    // 1. Review step without stickers still shows the browser-persistence reassurance.
    const { workflow: reviewWorkflow } = makeWorkflow(
      setup('review', {
        telegram: signedIn,
        signal: linked,
        chosen: { stickers: false, friends: false, saved: true },
        saved: { kind: 'read', instance: 'ui-1', attempt: 1, messages: [] },
      }),
    );
    const reviewApp = document.createElement('migration-app') as MigrationApp;
    reviewApp.workflow = reviewWorkflow;
    host.appendChild(reviewApp);
    await reviewApp.updateComplete;
    await tick();
    const reviewText = reviewApp.querySelector('main')?.textContent ?? '';

    // 2. Migrate step reopened mid-sticker-migration with friendsAdded + savedDone persisted (no re-fetch).
    const host2 = clearBody();
    const { workflow: migrateWorkflow } = makeWorkflow({
      ...session({
        telegram: signedIn,
        signal: linked,
        chosen: { stickers: true, friends: true, saved: true },
        friends: { kind: 'none' },
        friendsAdded: { aci: device.aci, count: 5 },
        saved: { kind: 'none' },
        savedDone: { aci: device.aci, copied: 8 },
        stickerProgress: {
          pendingPacks: [],
          uploadLimit: null,
          installedFromIndex: [],
          uploadedPacks: [],
          addedToIndex: 3,
        },
      }),
      kind: 'migrating',
      run: { attempt: 1, status: 'running', error: null },
    });
    const app = document.createElement('migration-app') as MigrationApp;
    app.workflow = migrateWorkflow;
    host2.appendChild(app);
    await app.updateComplete;
    await tick();
    const runningHeader = app.querySelector('main header')?.textContent ?? '';
    const friendsText = app.querySelector('section[aria-label="Friends"]')?.textContent ?? '';
    const savedText = app.querySelector('section[aria-label="Saved Messages"]')?.textContent ?? '';
    const connectionsText = app.querySelector('nav')?.textContent ?? '';

    // 3. Offline reopen (telegram.kind === 'stopped') shows stopped description + Try again button.
    migrateWorkflow.state = {
      ...session({
        telegram: { kind: 'stopped', method: 'qr', instance: 'ui-1', attempt: 1, error: 'offline 503' },
        signal: linked,
        chosen: { stickers: false, friends: false, saved: true },
        saved: { kind: 'none' },
      }),
      kind: 'migrating',
      run: { attempt: 1, status: 'running', error: null },
    };
    migrateWorkflow.dispatchEvent(new Event('change'));
    await app.updateComplete;
    await tick();
    const stoppedHeader = app.querySelector('main header')?.textContent ?? '';
    const stoppedButtons = [...app.querySelectorAll('main button')].map((b) => b.textContent?.trim() ?? '');

    return { reviewText, runningHeader, friendsText, savedText, connectionsText, stoppedHeader, stoppedButtons };
  },
};

declare global {
  interface Window {
    uiTests: typeof uiTests;
  }
}
window.uiTests = uiTests;
