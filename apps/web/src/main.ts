import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

// Application updates must never erase local music or reload an active player.
void bootstrapApplication(App, appConfig).catch((error) => console.error(error));
