// The wizard's steps, and which one is on screen.

export const STEPS = ['start', 'telegram', 'signal', 'packs', 'review', 'migrate'] as const;
export type Step = (typeof STEPS)[number];
export type SetupStep = Exclude<Step, 'migrate'>;
export const SETUP_STEPS: readonly string[] = STEPS.filter((step) => step !== 'migrate');

/**
 * The step on screen during setup: the furthest step, up to the one asked for, whose needs are met. Both logins come
 * before choosing packs, so that nobody chooses among 100+ packs before both are known to work.
 */
export function setupStepShown(asked: Step, signedIn: boolean, linked: boolean): Step {
  const needsMet: Record<Step, boolean> = {
    start: true,
    telegram: true,
    signal: signedIn,
    packs: signedIn && linked,
    review: signedIn && linked,
    migrate: signedIn && linked,
  };
  let shown: Step = 'start';
  for (const step of STEPS) {
    if (!needsMet[step]) break;
    shown = step;
    if (step === asked) break;
  }
  return shown;
}
