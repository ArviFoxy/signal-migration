// Mirrors the step on screen in the address bar (#/packs, #/review, ...), so that the browser's Back and Forward
// buttons move between steps.
//
// An address is a request that the workflow may refuse: it is accepted only for a step that can be on screen now
// (Workflow.canShow). Otherwise the address bar goes back to the step shown, and nothing else happens; an address
// typed by hand never starts a login or skips a step.
//
// Only the user's own navigation (Start, Continue, Back, starting the migration) adds an entry to the browser's
// history. Startup loading, automatic detours (a login completes, Signal is unlinked from the phone), and ending/clear
// transitions replace the current entry rather than pushing, so Back leads only to steps the user went through.

import { type AppState, STEPS, type SetupStep, type Step, type Workflow } from '../app/workflow';

const stepOf = (hash: string): Step | null => {
  const name = hash.replace(/^#\/?/, '');
  return (STEPS as readonly string[]).includes(name) ? (name as Step) : null;
};

const isLoading = (kind: AppState['kind']): boolean => kind === 'locking' || kind === 'loading';

type NavMarker = { kind: AppState['kind']; step: SetupStep | null };

const navOf = (workflow: Workflow): NavMarker => ({
  kind: workflow.state.kind,
  step: workflow.state.kind === 'setup' ? workflow.state.step : null,
});

/** True only for explicit user-driven step changes that should push a browser history entry. */
function isUserNavigation(prev: NavMarker, next: NavMarker): boolean {
  if (prev.kind === 'setup' && next.kind === 'setup') return prev.step !== next.step;
  if (prev.kind === 'setup' && next.kind === 'migrating') return true;
  if (prev.kind === 'migrating' && next.kind === 'setup') return true;
  return false;
}

export function connectRouter(workflow: Workflow): () => void {
  let initialized = !isLoading(workflow.state.kind);
  let shown: Step = workflow.step;
  let previous = navOf(workflow);
  let followingHistory = false;

  if (initialized && stepOf(location.hash) !== shown) {
    history.replaceState(null, '', `#/${shown}`);
  }

  const onChange = () => {
    if (isLoading(workflow.state.kind)) return;
    const next = navOf(workflow);
    if (!initialized) {
      initialized = true;
      shown = workflow.step;
      previous = next;
      if (stepOf(location.hash) !== shown) history.replaceState(null, '', `#/${shown}`);
      return;
    }
    const asked = isUserNavigation(previous, next) && !followingHistory;
    previous = next;
    if (workflow.step === shown) return;
    shown = workflow.step;
    if (stepOf(location.hash) === shown) return;
    if (asked) history.pushState(null, '', `#/${shown}`);
    else history.replaceState(null, '', `#/${shown}`);
  };

  const onPopState = () => {
    if (isLoading(workflow.state.kind)) return;
    const wanted = stepOf(location.hash);
    if (wanted && workflow.canShow(wanted)) {
      followingHistory = true;
      workflow.goTo(wanted);
      followingHistory = false;
    }
    if (stepOf(location.hash) !== workflow.step) history.replaceState(null, '', `#/${workflow.step}`);
  };

  workflow.addEventListener('change', onChange);
  window.addEventListener('popstate', onPopState);
  return () => {
    workflow.removeEventListener('change', onChange);
    window.removeEventListener('popstate', onPopState);
  };
}
