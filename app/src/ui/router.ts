// Mirrors the workflow's step in the address bar (#/packs, #/review, ...), so that the browser's Back and Forward
// buttons move between steps. The workflow decides: an address for a step that is not reachable yet is replaced by
// the current step's.

import { ROUTES, type Route, type Workflow } from '../app/workflow';

const routeOf = (hash: string): Route | null => {
  const name = hash.replace(/^#\/?/, '');
  return (ROUTES as readonly string[]).includes(name) ? (name as Route) : null;
};

export function connectRouter(workflow: Workflow): void {
  let shown: Route = workflow.route;
  history.replaceState(null, '', `#/${shown}`);
  workflow.addEventListener('change', () => {
    if (workflow.route === shown) return;
    shown = workflow.route;
    if (routeOf(location.hash) !== shown) history.pushState(null, '', `#/${shown}`);
  });
  window.addEventListener('popstate', () => {
    const wanted = routeOf(location.hash);
    if (wanted && workflow.navigate(wanted)) return;
    history.replaceState(null, '', `#/${workflow.route}`);
  });
}
