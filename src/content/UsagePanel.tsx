import { useEffect, useState } from 'preact/hooks';
import { remainingFor } from '~/assets/mark';
import { thresholdState } from '~/core/normalise';
import { allowanceWindow } from '~/core/windows';
import type {
  DailyRollup,
  LimitWindow,
  Projection as ProjectionResult,
  Settings as SettingsValues,
} from '~/core/types';
import { GearIcon } from '~/popup/components/GearIcon';
import { HistoryStrip } from '~/popup/components/HistoryStrip';
import { Mark } from '~/popup/components/Mark';
import { Projection } from '~/popup/components/Projection';
import { Settings } from '~/popup/components/Settings';
import { TelegramCard } from '~/popup/components/TelegramCard';
import { UsageMeter } from '~/popup/components/UsageMeter';
import { panelAnchor, setPanelOpen, usePanelOpen } from './panel';

/** Gap between the sidebar card and the panel, in pixels. */
const GAP = 12;

/** Smallest margin the panel keeps from the edge of the viewport. */
const MARGIN = 12;

/** Below this the panel is not worth opening, so it stops being pushed up. */
const MIN_HEIGHT = 240;

/** Never narrower than this, even in a window with no room for it. */
const MIN_WIDTH = 280;

interface UsagePanelProps {
  windows: LimitWindow[];
  history: DailyRollup[];
  projection: ProjectionResult | null;
  settings: SettingsValues;
  onChange(patch: Partial<SettingsValues>): void;
  /**
   * Revoke the relay token. There is deliberately no `onConnect` counterpart:
   * connecting needs `chrome.permissions.request`, and a content script has no
   * access to `chrome.permissions` and no way to get one. The settings screen
   * says so rather than offering a field that cannot work.
   */
  onDisconnect?: () => void;
  now: number;
}

interface Position {
  top: number;
  left: number;
  maxWidth: number;
  maxHeight: number;
}

/**
 * The expanded panel — the in-situ artboard's floating panel, in the main frame.
 *
 * It renders beside the card rather than inside the sidebar, and that is a fix
 * rather than a preference: the sidebar scrolls, so a panel positioned out of it
 * is clipped by the scroll container and appears to open *within* the
 * navigation. Mounted in the main content area it has the room the artboard
 * draws it with. docs/design.md deviation 4.
 *
 * Position is measured, not assumed. The archive's `left:302px` is a coordinate
 * on a canvas; a real sidebar can be any width and the user can resize it, so
 * the panel reads the card's own bounding box and opens a fixed gap to its
 * right, clamped to the viewport in both directions.
 */
export function UsagePanel({
  windows,
  history,
  projection,
  settings,
  onChange,
  onDisconnect,
  now,
}: UsagePanelProps) {
  const open = usePanelOpen();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const position = useAnchoredPosition(open);

  // Escape closes it, as it closes every other dialog on the page. There is
  // deliberately no click-outside: the panel opens over someone else's
  // application, and swallowing a click meant for the composer would be a
  // worse surprise than leaving the panel open.
  useEffect(() => {
    if (!open) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPanelOpen(false);
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  // Settings belong to an open panel. Leaving them open behind a closed one
  // means reopening the panel lands on a screen the user never asked for.
  useEffect(() => {
    if (!open) setSettingsOpen(false);
  }, [open]);

  if (!open || windows.length === 0) return null;

  const weekly = allowanceWindow(windows) ?? undefined;
  const shown = windows.filter((window) => {
    if (weekly !== undefined && window.key === weekly.key) return settings.display.weekly;
    return true;
  });
  const remaining = remainingFor(windows.map((w) => w.utilization));
  const worstState = thresholdState(
    remaining === null ? null : 100 - remaining,
    weekly?.status ?? 'unknown',
  );

  return (
    <div class="wick-root">
      <div
        class="wick-panel wick-panel--anchored"
        role="dialog"
        aria-label="Wick usage"
        style={
          position === null
            ? undefined
            : {
                top: `${position.top}px`,
                left: `${position.left}px`,
                maxWidth: `${position.maxWidth}px`,
                maxHeight: `${position.maxHeight}px`,
              }
        }
      >
        <header class="wick-panel__header">
          <div class="wick-panel__brand">
            <Mark remaining={remaining} state={worstState} />
            <span class="wick-panel__title">Wick</span>
          </div>
          <div class="wick-panel__header-actions">
            <button
              type="button"
              class="wick-panel__close"
              aria-label="Close"
              onClick={() => setPanelOpen(false)}
            >
              ×
            </button>
          </div>
        </header>

        <div class="wick-panel__body">
          {shown.map((window) => (
            <UsageMeter key={window.key} window={window} now={now} />
          ))}

          {settings.display.forecast && projection !== null && weekly !== undefined && (
            <Projection
              projection={projection}
              state={worstState}
              resetsAt={weekly.resetsAt}
              now={now}
            />
          )}

          {settings.display.sparkline && (
            <HistoryStrip history={history} windowKey={weekly?.key ?? ''} now={now} compact />
          )}

          <div class="wick-rule" />

          <TelegramCard
            connected={settings.relayToken !== null}
            threshold={settings.alertThreshold}
            alsoOnReset={settings.alertOnReset}
          />
        </div>

        <footer class="wick-panel__footer">
          <button type="button" class="wick-button wick-button--grow">
            View history
          </button>
          <button
            type="button"
            class="wick-button wick-button--icon"
            aria-label="Settings"
            title="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            <GearIcon />
          </button>
        </footer>

        {settingsOpen && (
          <div class="wick-modal" role="dialog" aria-label="Wick settings">
            <Settings
              settings={settings}
              onChange={onChange}
              {...(onDisconnect === undefined ? {} : { onDisconnect })}
              onClose={() => setSettingsOpen(false)}
              version={chrome.runtime.getManifest().version}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Where to put the panel, measured against the card.
 *
 * Re-measured on resize and on any scroll — the card rides the sidebar's own
 * scroll container, so it moves without the window moving. Both listeners exist
 * only while the panel is open; a listener on every scroll of someone else's
 * application is exactly the kind of thing a guest does not leave running.
 */
function useAnchoredPosition(open: boolean): Position | null {
  const [position, setPosition] = useState<Position | null>(null);

  useEffect(() => {
    if (!open) return undefined;

    const measure = () => setPosition(positionBeside(panelAnchor()));
    measure();

    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, { capture: true, passive: true });

    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, { capture: true });
    };
  }, [open]);

  return position;
}

/** The panel's viewport coordinates, given the card it opens beside. */
export function positionBeside(
  card: HTMLElement | null,
  viewport = { width: window.innerWidth, height: window.innerHeight },
): Position | null {
  if (card === null) return null;

  const rect = card.getBoundingClientRect();

  // A card with no box — a hidden sidebar, a collapsed rail — gives nothing to
  // measure against, so the panel falls back to the edge of the viewport rather
  // than opening at 0,0 underneath the navigation.
  const right = rect.width === 0 && rect.height === 0 ? MARGIN : rect.right + GAP;

  const left = Math.round(Math.max(MARGIN, Math.min(right, viewport.width - MIN_WIDTH - MARGIN)));
  const top = Math.round(
    Math.max(MARGIN, Math.min(rect.top || MARGIN, viewport.height - MIN_HEIGHT)),
  );

  return {
    top,
    left,
    maxWidth: Math.max(MIN_WIDTH, viewport.width - left - MARGIN),
    maxHeight: Math.max(MIN_HEIGHT, viewport.height - top - MARGIN),
  };
}
