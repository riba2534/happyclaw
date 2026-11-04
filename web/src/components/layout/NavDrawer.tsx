import { useEffect, useMemo, useRef, useState, type TouchEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronsUpDown, Menu, Search, SquarePen } from 'lucide-react';
import { useAuthStore, useIsGuest } from '../../stores/auth';
import { useBillingStore } from '../../stores/billing';
import { useShellStore } from '../../stores/shell';
import { useNewConversation } from '../../hooks/useNewConversation';
import { lazyBugReportDialog } from '../common/lazy-dialogs';
import { useOpenedOnce } from '../../lib/preloaded-component';
import { EmojiAvatar } from '../common/EmojiAvatar';
import { IconButton } from '../common/IconButton';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AccountMenuItems, GuestBadge } from './AccountMenu';
import { filterNavItems } from './nav-items';
import { useIsSingleUserHost } from '../../lib/deployment-mode';

const BugReportDialog = lazyBugReportDialog.Component;

/** The top-left hamburger of phone pages; opens the navigation drawer. */
export function NavDrawerButton() {
  const setOpen = useShellStore((s) => s.setNavDrawerOpen);
  return (
    <IconButton
      label="打开菜单"
      icon={<Menu className="size-5" />}
      size="icon"
      hideTooltip
      onClick={() => setOpen(true)}
      className="size-11 rounded-full text-foreground"
    />
  );
}

/** How far left (px) a released drag must have gone to close the drawer. */
const SWIPE_CLOSE_DISTANCE = 72;

/**
 * Drag the drawer left to close it (cindy's drawers follow the finger and
 * close past a threshold). The panel moves with the finger; a short or
 * vertical drag snaps back, and a vertical one scrolls the drawer.
 */
function useSwipeToClose(onClose: () => void) {
  const drag = useRef<{
    x: number;
    y: number;
    dx: number;
    horizontal: boolean | null;
  } | null>(null);
  const reset = (element: HTMLElement) => {
    element.style.transform = '';
    element.style.transition = '';
  };
  return {
    onTouchStart(event: TouchEvent<HTMLElement>) {
      const touch = event.touches[0];
      drag.current = {
        x: touch.clientX,
        y: touch.clientY,
        dx: 0,
        horizontal: null,
      };
    },
    onTouchMove(event: TouchEvent<HTMLElement>) {
      const state = drag.current;
      if (!state) return;
      const touch = event.touches[0];
      const dx = touch.clientX - state.x;
      const dy = touch.clientY - state.y;
      if (state.horizontal === null) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        state.horizontal = Math.abs(dx) > Math.abs(dy) * 1.2;
      }
      if (!state.horizontal) return;
      state.dx = Math.min(0, dx);
      event.currentTarget.style.transition = 'none';
      event.currentTarget.style.transform = `translateX(${state.dx}px)`;
    },
    onTouchEnd(event: TouchEvent<HTMLElement>) {
      const state = drag.current;
      drag.current = null;
      if (!state?.horizontal) return;
      const element = event.currentTarget;
      if (state.dx <= -SWIPE_CLOSE_DISTANCE) {
        // The exit animation slides on from where the finger left it.
        onClose();
        return;
      }
      element.style.transition = 'transform 200ms cubic-bezier(0.4, 0, 0.2, 1)';
      element.style.transform = '';
      window.setTimeout(() => reset(element), 200);
    },
    onTouchCancel(event: TouchEvent<HTMLElement>) {
      drag.current = null;
      reset(event.currentTarget);
    },
  };
}

const drawerRowClass =
  'flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-xl px-3 text-left text-base font-medium text-foreground outline-none transition-colors active:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default disabled:opacity-60 data-[active=true]:bg-surface-selected [&_svg]:size-5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground';

/**
 * Phone navigation, after cindy's home drawer: the account, search and new
 * conversation, then the pages of the desktop sidebar. It slides in from
 * the left over the page and closes on any choice.
 */
export function NavDrawer() {
  const open = useShellStore((s) => s.navDrawerOpen);
  const setOpen = useShellStore((s) => s.setNavDrawerOpen);
  const location = useLocation();
  const user = useAuthStore((s) => s.user);
  const isGuest = useIsGuest();
  const singleUserHost = useIsSingleUserHost();
  const billingEnabled = useBillingStore((s) => s.billingEnabled);
  const setPaletteOpen = useShellStore((s) => s.setPaletteOpen);
  const { startNewConversation, creatingSession } = useNewConversation();
  const [showBugReport, setShowBugReport] = useState(false);
  const bugReportMounted = useOpenedOnce(showBugReport);
  const navItems = useMemo(
    () => filterNavItems(billingEnabled, isGuest, singleUserHost),
    [billingEnabled, isGuest, singleUserHost],
  );
  const userInitial = (user?.display_name ||
    user?.username ||
    '?')[0].toUpperCase();
  const swipe = useSwipeToClose(() => setOpen(false));

  // Any navigation, from here or elsewhere, leaves the drawer closed.
  useEffect(() => {
    setOpen(false);
  }, [location.pathname, location.search, setOpen]);

  return (
    <>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="left"
          showCloseButton={false}
          data-testid="nav-drawer"
          {...swipe}
          className="gap-0 overflow-y-auto overscroll-contain rounded-r-xl border-r-0 bg-surface-raised pt-[calc(env(safe-area-inset-top,0px)+1rem)] pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] pl-[env(safe-area-inset-left,0px)] data-[side=left]:w-[min(320px,82vw)] data-[side=left]:sm:max-w-none motion-reduce:animate-none"
        >
          <SheetTitle className="sr-only">导航</SheetTitle>
          <SheetDescription className="sr-only">
            搜索、新对话和应用页面
          </SheetDescription>
          {/* Not modal: the drawer already blocks the page. A modal menu
              closing with the drawer (a choice that navigates) can leave
              Radix's body `pointer-events: none` behind, a dead page, when
              the drawer finishes unmounting first. */}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="账户菜单"
                className="mx-2 flex min-h-16 cursor-pointer items-center gap-3 rounded-xl px-3 text-left outline-none active:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <EmojiAvatar
                  imageUrl={user?.avatar_url}
                  emoji={user?.avatar_emoji}
                  color={user?.avatar_color}
                  fallbackChar={userInitial}
                  size="md"
                  className="size-10 shrink-0"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-title text-foreground">
                    {user?.display_name || user?.username}
                  </span>
                  <span className="block truncate text-label text-muted-foreground">
                    @{user?.username}
                  </span>
                  <GuestBadge className="mt-1" />
                </span>
                <ChevronsUpDown className="size-4 shrink-0 text-faint-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-60">
              <AccountMenuItems
                inlineAppearance
                onReportBug={() => {
                  setOpen(false);
                  setShowBugReport(true);
                }}
              />
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="mx-5 my-2 h-px bg-surface-border" />

          <nav aria-label="主导航" className="flex flex-col gap-0.5 px-2">
            <button
              type="button"
              className={drawerRowClass}
              onClick={() => {
                setOpen(false);
                setPaletteOpen(true);
              }}
            >
              <Search />
              搜索
            </button>
            {!isGuest && (
              <button
                type="button"
                className={drawerRowClass}
                disabled={creatingSession}
                onClick={() => {
                  setOpen(false);
                  void startNewConversation({ target: 'home' });
                }}
              >
                <SquarePen />
                新对话
              </button>
            )}
            <div className="mx-3 my-1.5 h-px bg-surface-border" />
            {navItems.map(({ path, icon: Icon, label }) => {
              const active = location.pathname.startsWith(path);
              return (
                <Link
                  key={path}
                  to={path}
                  data-active={active || undefined}
                  aria-current={active ? 'page' : undefined}
                  className={drawerRowClass}
                  // The current page's own link does not change the route.
                  onClick={() => setOpen(false)}
                >
                  <Icon />
                  {label}
                </Link>
              );
            })}
          </nav>
        </SheetContent>
      </Sheet>
      {bugReportMounted && (
        <BugReportDialog
          open={showBugReport}
          onClose={() => setShowBugReport(false)}
        />
      )}
    </>
  );
}
