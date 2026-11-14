// The wizard's steps, and which one is on screen.

export const STEPS = ['start', 'telegram', 'signal', 'packs', 'friends', 'review', 'migrate'] as const;
export type Step = (typeof STEPS)[number];
export type SetupStep = Exclude<Step, 'migrate'>;
export const SETUP_STEPS: readonly string[] = STEPS.filter((step) => step !== 'migrate');

/** What the user chose to move on the start page. Each kind has a step of its own in the setup. */
export type Chosen = { stickers: boolean; friends: boolean };

/** Whether `step` is part of the setup for what the user chose. */
export const stepIncluded = (step: Step, chosen: Chosen): boolean =>
  step === 'packs' ? chosen.stickers : step === 'friends' ? chosen.friends : true;

/**
 * The step on screen during setup: the furthest step, up to the one asked for, whose needs are met. Both logins come
 * before choosing packs, so that nobody chooses among 100+ packs before both are known to work. The step of a kind
 * the user did not choose is passed over.
 */
export function setupStepShown(asked: Step, signedIn: boolean, linked: boolean, chosen: Chosen): Step {
  const needsMet: Record<Step, boolean> = {
    start: true,
    telegram: true,
    signal: signedIn,
    packs: signedIn && linked,
    friends: signedIn && linked,
    review: signedIn && linked,
    migrate: signedIn && linked,
  };
  let shown: Step = 'start';
  let reached = false;
  for (const step of STEPS) {
    if (!needsMet[step]) break;
    reached ||= step === asked;
    if (!stepIncluded(step, chosen)) continue;
    shown = step;
    if (reached) break;
  }
  return shown;
}
