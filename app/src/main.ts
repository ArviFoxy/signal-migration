// The web app's entry point: the workflow with the real services, the router, and the view; then continues a
// migration kept in this browser, if there is one.

import { realServices } from './app/services';
import { Workflow } from './app/workflow';
import type { MigrationApp } from './ui/migration-app';
import './ui/migration-app';
import { connectRouter } from './ui/router';

const workflow = new Workflow(realServices);
const app = document.querySelector('migration-app') as MigrationApp;
app.workflow = workflow;
void workflow.restore().then(() => connectRouter(workflow));
