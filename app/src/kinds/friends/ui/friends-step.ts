// The friends step: the people from the user's Telegram chats who have a Signal account, for the user to choose who
// is added to the Signal contacts. It looks the same whichever source found a person.
//
// The list follows the Telegram chat list: one-to-one chats and groups in its order. A group opens in place and
// stands for the people found in it. What is chosen is a set of people: a person's tick is the same tick in their own
// row and inside every group. The list can also show the people alone, each once, to see who is chosen.

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
import { type FoundFriend, friendRows, type FriendSearch, friendsIn } from '../search';
import { type ChatEntry, nameOf } from '../telegram-people';

// One screen in every state: the same title and description, with the progress of the search where the list will be.
const TITLE = 'Friends on Signal';
const DESCRIPTION = 'Select who to add to your Signal contacts.';
const people = (count: number) => `${count} ${count === 1 ? 'person' : 'people'}`;

type Found = Extract<FriendsState, { kind: 'found' }>;
type Group = Extract<ChatEntry, { kind: 'group' }>;
/** What the list shows: the chat list with its groups, or the people alone. */
type View = 'chats' | 'people';

/** The time left in words, once it can be estimated. */
function timeLeft(seconds: number | null): string | typeof nothing {
  if (seconds === null) return nothing;
  if (seconds < 50) return 'Less than a minute left';
  const minutes = Math.round(seconds / 60);
  return `About ${minutes} minute${minutes === 1 ? '' : 's'} left`;
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => [...word][0] ?? '')
    .join('')
    .toUpperCase();

/** An address for each picture's bytes, made once. Telegram's profile pictures are JPEG files. */
const pictureUrls = new WeakMap<Uint8Array, string>();
function pictureUrl(bytes: Uint8Array): string {
  let url = pictureUrls.get(bytes);
  if (!url) {
    url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }));
    pictureUrls.set(bytes, url);
  }
  return url;
}

@customElement('friends-step')
export class FriendsStep extends LightElement {
  @property({ attribute: false }) friends!: FriendsState;
  /** The Telegram user IDs of found people the user ticked. Nobody is ticked until the user ticks them. */
  @property({ attribute: false }) ticked: readonly number[] = [];
  /** Where the step stands in the step list. */
  @property({ attribute: false }) position: StepPosition | null = null;
  /** The chat ID of the group whose members are shown. */
  @state() private open: number | null = null;
  @state() private search = '';
  @state() private view: View = 'chats';
  /** Which list is shown: the chats, or the Telegram contact list. */
  @state() private list: 'chats' | 'contacts' = 'chats';

  private tick(userIds: number[], ticked: boolean): void {
    this.emit('tick', { userIds, ticked });
  }

  private footer(next: TemplateResult): TemplateResult {
    return stickyFooter(
      html`<button type="button" class=${secondaryButton} @click=${() => this.emit('back')}>Back</button>${next}`,
    );
  }

  /**
   * The Telegram picture of a person or a group. Until it is read, Telegram's small blurred copy of it stands in; the
   * initials of the name where there is no picture at all.
   */
  private avatar(name: string, picture: Uint8Array | undefined, preview: string | undefined, small = false) {
    const size = small ? 'size-7 text-[11px]' : 'size-10 text-sm';
    const address = picture ? pictureUrl(picture) : preview ? `data:image/jpeg;base64,${preview}` : null;
    if (address) {
      return html`<img src=${address} alt="" class="${size} flex-none rounded-full object-cover" />`;
    }
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
      .checked=${this.ticked.includes(userId)}
      @change=${(event: Event) => this.tick([userId], (event.target as HTMLInputElement).checked)}
    />`;
  }

  private personRow(found: Found, friend: FoundFriend, note: string) {
    const name = nameOf(friend.person);
    return html`<li class="flex min-h-16 items-center gap-3 border-b border-line px-4 last:border-b-0">
      ${this.avatar(name, found.photos.get(`user:${friend.person.userId}`), friend.person.photoPreview)}
      <span class="flex min-w-0 flex-1 flex-col">
        <span class="truncate text-[15px] font-semibold">${name}</span>
        <span class="truncate text-[13px] text-muted">${friend.inSignal ? 'In your Signal' : note}</span>
      </span>
      ${this.personTick(friend)}
    </li>`;
  }

  private groupRow(found: Found, chat: Group) {
    const search = found.search;
    const members = chat.memberIds.map((userId) => search.found.get(userId)!);
    const addable = members.filter((friend) => !friend.inSignal).map((friend) => friend.person.userId);
    const ticked = addable.filter((userId) => this.ticked.includes(userId)).length;
    const all = addable.length > 0 && ticked === addable.length;
    const expanded = this.open === chat.chatId;
    return html`<li class="border-b border-line last:border-b-0">
      <div class="flex min-h-16 items-center gap-3 px-4">
        ${this.avatar(chat.title, found.photos.get(`chat:${chat.chatId}`), chat.photoPreview)}
        <span class="flex min-w-0 flex-1 flex-col">
          <span class="truncate text-[15px] font-semibold">${chat.title}</span>
          <span class="truncate text-[13px] text-muted"
            >${members.length} of ${chat.memberCount} member${chat.memberCount === 1 ? '' : 's'} on Signal</span
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
                  ${this.avatar(name, found.photos.get(`user:${friend.person.userId}`), friend.person.photoPreview, true)}
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

  /** A row of buttons of which one is chosen. The contact list has no groups, so its second row is switched off. */
  private choice<T extends string>(
    label: string,
    options: { id: T; label: string }[],
    chosen: T,
    choose: (id: T) => void,
    disabled = false,
  ) {
    return html`<div
      role="group"
      aria-label=${label}
      class="inline-flex gap-1 rounded-[10px] bg-segment p-1 ${disabled ? 'opacity-50' : ''}"
    >
      ${options.map(
        (option) =>
          html`<button
            type="button"
            aria-pressed=${option.id === chosen}
            ?disabled=${disabled}
            class="min-h-9 rounded-lg px-3 text-[13px] font-medium ${disabled ? '' : 'cursor-pointer'} ${
              option.id === chosen ? 'bg-white text-ink shadow-[0_1px_2px_rgba(20,20,30,0.12)]' : 'text-muted'
            }"
            @click=${() => choose(option.id)}
          >
            ${option.label}
          </button>`,
      )}
    </div>`;
  }

  /** The search while it runs: which of its two parts, and how far it is. */
  private looking(friends: Extract<FriendsState, { kind: 'none' | 'looking' }>) {
    const progress = friends.kind === 'looking' ? friends.progress : null;
    // Reading the chats has a known length; asking Signal is one request.
    const label =
      progress?.part === 'signal'
        ? 'Looking up Signal accounts by phone number'
        : 'Looking for Telegram contacts with a phone number';
    const count = !progress
      ? nothing
      : progress.part === 'signal'
        ? html`<span class="flex-none whitespace-nowrap text-muted tabular-nums"
            >${progress.phoneNumbers} phone number${progress.phoneNumbers === 1 ? '' : 's'}</span
          >`
        : html`<span class="flex-none whitespace-nowrap text-muted tabular-nums"
            >${progress.groupsRead} of ${progress.groups} groups</span
          >`;
    const bar = !progress
      ? progressBar(label, 0, 0)
      : progress.part === 'signal'
        ? html`<div class="animate-pulse">${progressBar(label, 1, 1)}</div>`
        : progressBar(label, Math.round(progress.share * 100), 100);
    // The line below the bar is there from the start, so nothing moves when the estimate appears on it.
    return html`${stepHeader(this.position, TITLE, DESCRIPTION)}
      <div class="flex flex-col gap-1.5">
        <div class="flex justify-between gap-3 text-sm">
          <span class="font-semibold">${label}</span>
          ${count}
        </div>
        ${bar}
        <div class="flex min-h-5 justify-between gap-3 text-sm text-muted">
          <span>${progress?.part === 'telegram' ? timeLeft(progress.secondsLeft) : nothing}</span>
          <span class="flex-none whitespace-nowrap tabular-nums"
            >${progress?.part === 'telegram' ? `${people(progress.people)} scanned` : nothing}</span
          >
        </div>
      </div>
      ${this.footer(html`<button type="button" class=${primaryButton} disabled>Continue</button>`)}`;
  }

  /** Where the user knows each found person from: a one-to-one chat, or the groups they share. */
  private origins(search: FriendSearch): Map<number, string> {
    const direct = new Set<number>();
    const groups = new Map<number, string[]>();
    for (const chat of search.chats) {
      if (chat.kind === 'person') direct.add(chat.userId);
      else for (const userId of chat.memberIds) groups.set(userId, [...(groups.get(userId) ?? []), chat.title]);
    }
    return new Map(
      [...search.found.keys()].map((userId) => {
        const titles = groups.get(userId) ?? [];
        const others = titles.length - 1;
        const fromGroups = others > 0 ? `${titles[0]} and ${others} more` : (titles[0] ?? '');
        return [userId, direct.has(userId) ? 'Direct chat' : fromGroups];
      }),
    );
  }

  render() {
    const friends = this.friends;
    if (friends.kind === 'none' || friends.kind === 'looking') return this.looking(friends);
    if (friends.kind === 'failed') {
      return html`${stepHeader(this.position, TITLE, DESCRIPTION)}
      ${this.footer(
        html`<button type="button" class=${primaryButton} @click=${() => this.emit('try-again')}>Try again</button>`,
      )}`;
    }

    const search = friends.search;
    const everyone = [...search.found.values()];
    const toAdd = everyone.filter((friend) => !friend.inSignal && this.ticked.includes(friend.person.userId)).length;
    const next = html`<span class="flex items-center gap-4">
      <span class="text-sm text-muted">${toAdd === 0 ? 'Nobody to add' : `${people(toAdd)} to add`}</span>
      <button type="button" class=${primaryButton} @click=${() => this.emit('next')}>Continue</button>
    </span>`;

    if (everyone.length === 0) {
      return html`${stepHeader(this.position, TITLE, DESCRIPTION)}
        <p class="text-sm text-muted">
          None of the ${people(search.looked)} in your Telegram chats and contacts was found on Signal.
        </p>
        ${this.footer(next)}`;
    }

    const shown = friendRows(search, { list: this.list, groups: this.view === 'chats', text: this.search });
    // "Select all" is about the rows shown, not about everyone found.
    const addable = friendsIn(shown, search)
      .filter((friend) => !friend.inSignal)
      .map((friend) => friend.person.userId);
    const all = addable.length > 0 && addable.every((userId) => this.ticked.includes(userId));
    const origins = this.origins(search);
    const note = (userId: number) =>
      this.list === 'contacts'
        ? origins.get(userId) || 'Telegram contact'
        : this.view === 'people'
          ? (origins.get(userId) ?? '')
          : 'Direct chat';
    const rows = shown.map((row) =>
      row.kind === 'person'
        ? this.personRow(friends, row.friend, note(row.friend.person.userId))
        : this.groupRow(friends, row.chat),
    );
    const nothingShown =
      this.search.trim() !== ''
        ? 'Nothing matches.'
        : this.list === 'contacts'
          ? 'None of your Telegram contacts was found on Signal.'
          : 'None of the people in your Telegram chats was found on Signal.';
    const views: { id: View; label: string }[] = [
      { id: 'chats', label: 'Users and groups' },
      { id: 'people', label: 'Users only' },
    ];
    return html`${stepHeader(this.position, TITLE, DESCRIPTION)}
      <div class="flex flex-col gap-2">
        <label class="flex min-h-11 items-center gap-2 rounded-xl bg-segment px-3">
          ${icons.search()}
          <span class="sr-only">Search</span>
          <input
            type="search"
            placeholder="Search"
            class="min-w-0 flex-1 bg-transparent text-[15px] outline-none"
            .value=${this.search}
            @input=${(event: Event) => (this.search = (event.target as HTMLInputElement).value)}
          />
        </label>
        <div class="flex flex-wrap items-center gap-2">
          ${this.choice(
            'Which list',
            [
              { id: 'chats', label: 'Chats' },
              { id: 'contacts', label: 'Contacts' },
            ],
            this.list,
            (list) => (this.list = list),
          )}
          ${this.choice('What the list shows', views, this.view, (view) => (this.view = view), this.list === 'contacts')}
        </div>
        <div class="flex min-h-9 items-center justify-between gap-2">
          <span class="text-sm text-muted">${everyone.length} of ${people(search.looked)} are on Signal</span>
          ${
            addable.length > 0
              ? html`<button
                  type="button"
                  class="min-h-9 cursor-pointer rounded-[10px] px-3 text-sm font-semibold text-accent hover:bg-accent-soft"
                  @click=${() => this.tick(addable, !all)}
                >
                  ${all ? 'Select none' : 'Select all'}
                </button>`
              : nothing
          }
        </div>
        ${
          rows.length === 0
            ? html`<p class="text-sm text-muted">${nothingShown}</p>`
            : html`<ul
                aria-label=${this.list === 'contacts' ? 'Contacts' : this.view === 'people' ? 'People' : 'Chats'}
                class="flex shrink-0 flex-col overflow-hidden rounded-xl ring-1 ring-card-line ring-inset"
              >
                ${rows}
              </ul>`
        }
      </div>
      ${this.footer(next)}`;
  }
}
