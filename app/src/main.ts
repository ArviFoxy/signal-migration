// The web app's entry point: the workflow with the real services, the view and the router; then the workflow loads
// what this browser kept and continues from there.

import { realServices } from './app/services';
import { Workflow } from './app/workflow';
import type { MigrationApp } from './ui/migration-app';
import './ui/migration-app';
import { connectRouter } from './ui/router';

const workflow = new Workflow(realServices);
const app = document.querySelector('migration-app') as MigrationApp;
app.workflow = workflow;
void workflow.load().then(() => connectRouter(workflow));
