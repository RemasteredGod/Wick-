/**
 * Service worker entry point.
 *
 * Listeners are registered synchronously at the top level. An MV3 worker is
 * woken by an event and torn down again when idle, so a listener attached
 * inside a promise callback may simply not exist by the time the event it wants
 * arrives.
 *
 * The modules below do not know about each other. The collector writes to the
 * store; the icon renderer and the alert dispatcher each subscribe to storage
 * changes; the board reporter rides the same polling alarm to publish yesterday's
 * count. Adding another consumer means writing one file and adding one line here.
 */

import { initAlerts } from './alerts';
import { initBoard } from './board';
import { initCollector } from './collector';
import { initIcon } from './icon';

initCollector();
initIcon();
initAlerts();
initBoard();
