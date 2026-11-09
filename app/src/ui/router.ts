// Mirrors the step on screen in the address bar (#/packs, #/review, ...), so that the browser's Back and Forward
// buttons move between steps.
//
// An address is a request that the workflow may refuse: it is accepted only for a step that can be on screen now
// (Workflow.canShow). Otherwise the address bar goes back to the step shown, and nothing else happens; an address
// typed by hand never starts a login or skips a step.
//
// Only the user's own navigation (Start, Continue, Back, starting the migration) adds an entry to the browser's
// history. When the step on screen changes by itself (a login completes, Signal is unlinked from the phone), the
// current entry is replaced, so that Back leads to steps the user actually went through.

import { STEPS, type Step, type Workflow } from '../app/workflow';

const stepOf = (hash: string): Step | null => {
  const name = hash.replace(/^#\/?/, '');
  return (STEPS as readonly string[]).includes(name) ? (name as Step) : null;
};

/** What the user asked for: the step asked for in setup, or the phase. */
const requestOf = (workflow: Workflow) => (workflow.state.kind === 'setup' ? workflow.state.step : workflow.state.kind);

export function connectRouter(workflow: Workflow): void {
  let shown: Step = workflow.step;
  let requested = requestOf(workflow);
  let followingHistory = false;
  history.replaceState(null, '', `#/${shown}`);
  workflow.addEventListener('change', () => {
    const request = requestOf(workflow);
    const asked = request !== requested && !followingHistory;
    requested = request;
    if (workflow.step === shown) return;
    shown = workflow.step;
    if (stepOf(location.hash) === shown) return;
    if (asked) history.pushState(null, '', `#/${shown}`);
    else history.replaceState(null, '', `#/${shown}`);
  });
  window.addEventListener('popstate', () => {
    const wanted = stepOf(location.hash);
    if (wanted && workflow.canShow(wanted)) {
      followingHistory = true;
      workflow.goTo(wanted);
      followingHistory = false;
    }
    if (stepOf(location.hash) !== workflow.step) history.replaceState(null, '', `#/${workflow.step}`);
  });
}
