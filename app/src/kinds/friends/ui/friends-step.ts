// The friends step: the people from the user's Telegram chats who have a Signal account, for the user to choose who
// is added to the Signal contacts. It looks the same whichever source found a person.
//
// The list follows the Telegram chat list: one-to-one chats and groups in its order. A group opens in place and
// stands for the people found in it. What is chosen is a set of people: a person's tick is the same tick in their own
// row and inside every group.

import { html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { FriendsState } from '../../../app/workflow';
import {
  icons,
  LightElement,
  primaryButton,
  progressBar,
  secondaryButton,
  stepHeader,
  type StepPosition,
  stickyFooter,
} from '../../../ui/layout';
import type { FoundFriend, FriendSearch } from '../search';
import { type ChatEntry, nameOf } from '../telegram-people';

// One screen in every state: the same title and description, with the progress of the search where the list will be.
const TITLE = 'Friends on Signal';
const DESCRIPTION = 'Select who to add to your Signal contacts.';
const people = (count: number) => `${count} ${count === 1 ? 'person' : 'people'}`;

const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => [...word][0] ?? '')
    .join('')
    .toUpperCase();

@customElement('friends-step')
export class FriendsStep extends LightElement {
  @property({ attribute: false }) friends!: FriendsState;
  /** The Telegram user IDs of found people the user unticked. */
  @property({ attribute: false }) unticked: readonly number[] = [];
  /** Where the step stands in the step list. */
  @property({ attribute: false }) position: StepPosition | null = null;
  /** The chat ID of the group whose members are shown. */
  @state() private open: number | null = null;
  @state() private search = '';

  private tick(userIds: number[], ticked: boolean): void {
    this.emit('tick', { userIds, ticked });
  }

  private footer(next: TemplateResult): TemplateResult {
    return stickyFooter(
      html`<button type="button" class=${secondaryButton} @click=${() => this.emit('back')}>Back</button>${next}`,
    );
  }

  private avatar(name: string, small = false) {
    const size = small ? 'size-7 text-[11px]' : 'size-10 text-sm';
    return html`<span
      aria-hidden="true"
      class="flex ${size} flex-none items-center justify-center rounded-full bg-accent-soft font-semibold text-accent"
      >${initials(name)}</span
    >`;
  }

  /** The tick of one person: unchangeable when the person is in the user's Signal already. */
  private personTick(friend: FoundFriend) {
    const name = nameOf(friend.person);
    if (friend.inSignal) {
      return html`<input
        type="checkbox"
        class="size-5 flex-none accent-accent"
        aria-label="${name} is in your Signal"
        checked
        disabled
      />`;
    }
    const userId = friend.person.userId;
    return html`<input
      type="checkbox"
      class="size-5 flex-none cursor-pointer accent-accent"
      aria-label="Add ${name} to Signal"
      .checked=${!this.unticked.includes(userId)}
      @change=${(event: Event) => this.tick([userId], (event.target as HTMLInputElement).checked)}
    />`;
  }

  private personRow(friend: FoundFriend) {
    const name = nameOf(friend.person);
    return html`<li class="flex min-h-16 items-center gap-3 border-b border-line px-4 last:border-b-0">
      ${this.avatar(name)}
      <span class="flex min-w-0 flex-1 flex-col">
        <span class="truncate text-[15px] font-semibold">${name}</span>
        <span class="truncate text-[13px] text-muted">${friend.inSignal ? 'In your Signal' : 'Direct chat'}</span>
      </span>
      ${this.personTick(friend)}
    </li>`;
  }

  private groupRow(chat: Extract<ChatEntry, { kind: 'group' }>, search: FriendSearch) {
    const memberCount = chat.memberCount;
    const members = chat.memberIds.map((userId) => search.found.get(userId)!);
    const addable = members.filter((friend) => !friend.inSignal).map((friend) => friend.person.userId);
    const ticked = addable.filter((userId) => !this.unticked.includes(userId)).length;
    const all = addable.length > 0 && ticked === addable.length;
    const expanded = this.open === chat.chatId;
    return html`<li class="border-b border-line last:border-b-0">
      <div class="flex min-h-16 items-center gap-3 px-4">
        ${this.avatar(chat.title)}
        <span class="flex min-w-0 flex-1 flex-col">
          <span class="truncate text-[15px] font-semibold">${chat.title}</span>
          <span class="truncate text-[13px] text-muted"
            >${members.length} of ${memberCount} member${memberCount === 1 ? '' : 's'} on Signal</span
          >
        </span>
        <button
          type="button"
          class="flex size-11 flex-none cursor-pointer items-center justify-center rounded-[10px] text-muted hover:bg-segment"
          aria-label="Members of ${chat.title} on Signal"
          aria-expanded=${expanded}
          @click=${() => (this.open = expanded ? null : chat.chatId)}
        >
          <span class="${expanded ? 'rotate-180' : ''}">${icons.chevronDown()}</span>
        </button>
        <input
          type="checkbox"
          class="size-5 flex-none accent-accent ${addable.length > 0 ? 'cursor-pointer' : ''}"
          aria-label=${
            addable.length > 0
              ? `Add everyone found in ${chat.title} to Signal`
              : `Everyone found in ${chat.title} is in your Signal`
          }
          .checked=${addable.length === 0 || all}
          .indeterminate=${ticked > 0 && !all}
          ?disabled=${addable.length === 0}
          @change=${() => this.tick(addable, !all)}
        />
      </div>
      ${
        expanded
          ? html`<ul class="flex flex-col pr-4 pb-2 pl-[68px]">
              ${members.map((friend) => {
                const name = nameOf(friend.person);
                return html`<li class="flex min-h-11 items-center gap-2.5">
                  ${this.avatar(name, true)}
                  <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate text-sm">${name}</span>
                    ${friend.inSignal ? html`<span class="text-xs text-muted">In your Signal</span>` : nothing}
                  </span>
                  ${this.personTick(friend)}
                </li>`;
              })}
            </ul>`
          : nothing
      }
    </li>`;
  }

  render() {
    const friends = this.friends;
    if (friends.kind === 'none' || friends.kind === 'looking') {
      const progress = friends.kind === 'looking' ? friends.progress : null;
      // The search has two parts. Reading the chats has a known length; asking Signal is one request.
      const asking = progress?.part === 'signal';
      const label = asking
        ? 'Looking up Signal accounts by phone number'
        : 'Looking for Telegram contacts with a phone number';
      const count = !progress
        ? nothing
        : progress.part === 'signal'
          ? html`<span class="flex-none whitespace-nowrap text-muted tabular-nums"
              >${progress.phoneNumbers} phone number${progress.phoneNumbers === 1 ? '' : 's'}</span
            >`
          : html`<span class="flex-none whitespace-nowrap text-muted tabular-nums"
              >${progress.done} of ${progress.total} chats</span
            >`;
      const bar = !progress
        ? progressBar(label, 0, 0)
        : progress.part === 'signal'
          ? html`<div class="animate-pulse">${progressBar(label, 1, 1)}</div>`
          : progressBar(label, progress.done, progress.total);
      return html`${stepHeader(this.position, TITLE, DESCRIPTION)}
        <div class="flex flex-col gap-1.5">
          <div class="flex justify-between gap-3 text-sm">
            <span class="font-semibold">${label}</span>
            ${count}
          </div>
          ${bar}
        </div>
        ${this.footer(html`<button type="button" class=${primaryButton} disabled>Continue</button>`)}`;
    }
    if (friends.kind === 'failed') {
      return html`${stepHeader(this.position, TITLE, DESCRIPTION)}
      ${this.footer(
        html`<button type="button" class=${primaryButton} @click=${() => this.emit('try-again')}>Try again</button>`,
      )}`;
    }

    const search = friends.search;
    const everyone = [...search.found.values()];
    const addable = everyone.filter((friend) => !friend.inSignal).map((friend) => friend.person.userId);
    const toAdd = addable.filter((userId) => !this.unticked.includes(userId)).length;
    const all = addable.length > 0 && toAdd === addable.length;
    const query = this.search.trim().toLowerCase();
    const matches = (name: string) => name.toLowerCase().includes(query);
    const rows = search.chats.filter((chat) =>
      chat.kind === 'person'
        ? matches(nameOf(search.found.get(chat.userId)!.person))
        : matches(chat.title) || chat.memberIds.some((userId) => matches(nameOf(search.found.get(userId)!.person))),
    );
    const next = html`<span class="flex items-center gap-4">
      <span class="text-sm text-muted">${toAdd === 0 ? 'Nobody to add' : `${people(toAdd)} to add`}</span>
      <button type="button" class=${primaryButton} @click=${() => this.emit('next')}>Continue</button>
    </span>`;

    if (everyone.length === 0) {
      return html`${stepHeader(this.position, TITLE, DESCRIPTION)}
        <p class="text-sm text-muted">
          None of the ${people(search.looked)} in your Telegram chats was found on Signal.
        </p>
        ${this.footer(next)}`;
    }
    return html`${stepHeader(this.position, TITLE, DESCRIPTION)}
      <div class="flex flex-col gap-2">
        <label class="flex min-h-11 items-center gap-2 rounded-xl bg-segment px-3">
          ${icons.search()}
          <span class="sr-only">Search chats</span>
          <input
            type="search"
            placeholder="Search"
            class="min-w-0 flex-1 bg-transparent text-[15px] outline-none"
            .value=${this.search}
            @input=${(event: Event) => (this.search = (event.target as HTMLInputElement).value)}
          />
        </label>
        <div class="flex items-center justify-between gap-3">
          <span class="text-sm text-muted">${everyone.length} of ${people(search.looked)} are on Signal</span>
          ${
            addable.length > 0
              ? html`<button
                  type="button"
                  class="min-h-11 cursor-pointer rounded-[10px] px-3 text-sm font-semibold text-accent hover:bg-accent-soft"
                  @click=${() => this.tick(addable, !all)}
                >
                  ${all ? 'Select none' : 'Select all'}
                </button>`
              : nothing
          }
        </div>
        ${
          rows.length === 0
            ? html`<p class="text-sm text-muted">No chats match.</p>`
            : html`<ul
                aria-label="Chats"
                class="flex shrink-0 flex-col overflow-hidden rounded-xl ring-1 ring-card-line ring-inset"
              >
                ${rows.map((chat) =>
                  chat.kind === 'person' ? this.personRow(search.found.get(chat.userId)!) : this.groupRow(chat, search),
                )}
              </ul>`
        }
      </div>
      ${this.footer(next)}`;
  }
}
