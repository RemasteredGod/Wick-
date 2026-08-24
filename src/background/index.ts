/**
 * Service worker entry point.
 *
 * Listeners are registered synchronously at the top level. An MV3 worker is
 * woken by an event and torn down again when idle, so a listener attached
 * inside a promise callback may simply not exist by the time the event it wants
 * arrives.
 *
 * The three modules below do not know about each other. The collector writes to
 * the store; the icon renderer and the alert dispatcher each subscribe to
 * storage changes. Adding a fourth consumer of snapshots means writing one file
 * and adding one line here.
 */

import { initAlerts } from './alerts';
import { initCollector } from './collector';
import { initIcon } from './icon';

initCollector();
initIcon();
initAlerts();
