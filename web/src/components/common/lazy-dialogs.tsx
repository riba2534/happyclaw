import { preloadedComponent } from '../../lib/preloaded-component';

// Dialogs the app shell can open but rarely does. Keeping them (and the
// directory browser and select primitives they pull in) out of the shell and
// chat chunks takes ~90KB of code off the first-load path; they are fetched
// when the browser is idle or on first open.
const Nothing = () => null;

export const lazyCreateContainerDialog = preloadedComponent(
  () =>
    import('../chat/CreateContainerDialog').then((m) => ({
      default: m.CreateContainerDialog,
    })),
  Nothing,
);

export const lazyBugReportDialog = preloadedComponent(
  () =>
    import('./BugReportDialog').then((m) => ({ default: m.BugReportDialog })),
  Nothing,
);
