// The web app's entry point: the workflow with the real services, the view and the router. The workflow starts by
// taking the lock of the tab that runs the migration, then continues from what this browser kept.

import { realServices } from './app/services';
import { Workflow } from './app/workflow';
import type { MigrationApp } from './ui/migration-app';
import './ui/migration-app';
import { connectRouter } from './ui/router';

const workflow = new Workflow(realServices);
const app = document.querySelector('migration-app') as MigrationApp;
app.workflow = workflow;
connectRouter(workflow);
workflow.start();
