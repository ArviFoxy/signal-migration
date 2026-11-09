// Shared parts of the sticker pack steps: a base element that re-renders when the migration changes, and how packs
// and their states are described.

import { html, type PropertyValues, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { LightElement } from '../../../ui/layout';
import type { ConversionSummary, PackEntry, PackState, StickerMigration } from '../migration';

export class MigrationView extends LightElement {
  @property({ attribute: false }) migration!: StickerMigration;
  #onChange = () => this.requestUpdate();

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('migration')) {
      (changed.get('migration') as StickerMigration | undefined)?.removeEventListener('change', this.#onChange);
      this.migration?.addEventListener('change', this.#onChange);
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.migration?.removeEventListener('change', this.#onChange);
  }
}

/** "48 stickers · animated": the count and the kind of stickers in a pack. */
export function packDescription(entry: PackEntry): string {
  const formats = new Set(entry.pack.stickers.map((sticker) => sticker.format));
  const kind = formats.size > 1 ? 'mixed' : formats.has('tgs') ? 'animated' : formats.has('webm') ? 'video' : 'static';
  const count = entry.pack.stickers.length;
  return `${count} sticker${count === 1 ? '' : 's'} · ${kind}`;
}

/** Whether the pack is already on Signal (in the user's account, or uploaded by someone). */
export const isOnSignal = (state: PackState) => state === 'in-signal' || state === 'available';

const CHIP = 'self-start rounded-full px-2.5 py-1 text-xs font-semibold';
export const chips = {
  onSignal: html`<span class="${CHIP} bg-accent-chip text-accent-chip-text">On Signal</span>`,
  upload: html`<span class="${CHIP} bg-upload-chip text-upload-text">Upload</span>`,
  failed: html`<span class="${CHIP} bg-[#FBE4E1] text-danger">Failed</span>`,
  checking: html`<span class="${CHIP} bg-segment text-muted">Checking</span>`,
};

export function stateChip(state: PackState): TemplateResult {
  if (state === 'checking') return chips.checking;
  if (state === 'failed') return chips.failed;
  return isOnSignal(state) ? chips.onSignal : chips.upload;
}

/** What converting a pack changed, such as "12 animated stickers · 60 → 30 fps · 384 px". */
export function conversionDescription(conversion: ConversionSummary | null): string | null {
  if (!conversion || (conversion.animated === 0 && conversion.reencoded === 0)) return null;
  const parts: string[] = [];
  if (conversion.animated > 0) {
    parts.push(
      `${conversion.animated} animated sticker${conversion.animated === 1 ? '' : 's'} converted to animated PNG`,
    );
    if (
      conversion.highestSourceFrameRate !== null &&
      conversion.lowestFrameRate !== null &&
      conversion.lowestFrameRate < conversion.highestSourceFrameRate
    ) {
      parts.push(`frame rate ${conversion.highestSourceFrameRate} → ${conversion.lowestFrameRate} fps`);
    }
    if (conversion.smallestSize !== null && conversion.smallestSize < 512)
      parts.push(`size 512 → ${conversion.smallestSize} px`);
  }
  if (conversion.reencoded > 0)
    parts.push(`${conversion.reencoded} image${conversion.reencoded === 1 ? '' : 's'} compressed`);
  return parts.join(' · ');
}

/** "41 min", "11 h 30 min": a duration for the user. */
export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
