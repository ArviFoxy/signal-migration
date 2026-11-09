// The final screen: what was installed and uploaded, and that both connections are closed.

import { html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { icons, primaryButton, stepHeader } from '../../../ui/layout';
import { MigrationView } from './view';

@customElement('sticker-done-step')
export class StickerDoneStep extends MigrationView {
  @property({ attribute: false }) telegramStatus = '';
  @property({ attribute: false }) signalStatus = '';

  render() {
    const migration = this.migration;
    const inSignal = migration.selected.filter((entry) => entry.state === 'in-signal').length;
    const card = (tone: string, label: string, value: number) =>
      html`<li class="flex flex-col gap-1.5 rounded-xl p-5 ${tone}">
        <span class="text-sm font-semibold">${label}</span>
        <span class="font-display text-4xl font-semibold">${value}</span>
      </li>`;
    const row = (name: string, status: string) =>
      html`<li class="flex flex-col gap-0.5 border-b border-[#F0F0EC] px-[18px] py-3.5 last:border-b-0">
        <span class="text-[15px] font-semibold">${name}</span><span class="text-sm text-muted">${status}</span>
      </li>`;
    return html`<span class="flex size-12 items-center justify-center rounded-full bg-accent text-white"
        >${icons.check(24)}</span
      >
      ${stepHeader(null, 'Done', `${inSignal} sticker pack${inSignal === 1 ? ' is' : 's are'} in your Signal account.`)}
      <ul class="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3.5">
        ${card('bg-accent-soft [&>span:first-child]:text-accent', 'Installed', migration.installProgress.done)}
        ${card('bg-upload-soft [&>span:first-child]:text-upload-text', 'Uploaded', migration.uploaded)}
        ${card('bg-panel ring-1 ring-line ring-inset [&>span:first-child]:text-muted', 'Added to pack index', migration.addedToIndex)}
      </ul>
      <section aria-labelledby="done-connections" class="flex flex-col gap-3">
        <h2 id="done-connections" class="text-base font-semibold">Connections</h2>
        <ul class="flex flex-col overflow-hidden rounded-xl ring-1 ring-card-line ring-inset">
          ${row('Telegram', this.telegramStatus)} ${row('Signal', this.signalStatus)}
          ${row('Sticker pack index', `Received the hash and Signal pack ID of ${migration.addedToIndex} uploaded pack${migration.addedToIndex === 1 ? '' : 's'}`)}
        </ul>
      </section>
      <div class="mt-auto flex flex-wrap justify-between gap-3">
        <span></span>
        <button type="button" class=${primaryButton} @click=${() => this.emit('restart')}>Move something else</button>
      </div>`;
  }
}
