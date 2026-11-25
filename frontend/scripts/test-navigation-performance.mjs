import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve('src')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')

const sidebar = read('components', 'layout', 'Sidebar.tsx')
const home = read('components', 'layout', 'WorkspaceTabs.tsx')
const layout = read('app', '(workspace)', 'layout.tsx')
const routes = read('lib', 'navigation', 'routes.ts')
const proxy = read('proxy.ts')
const providers = read('app', 'providers.tsx')
const loading = read('app', 'loading.tsx')
const feedback = read('hooks', 'useFeedback.ts')

assert.match(sidebar, /href:\s*["']\/writing["']/, 'Writing has its canonical address')
assert.ok(layout.includes('<WorkspaceTabs />') && routes.includes("ROOT_MODULES"), 'The five root modules are views of one mounted layout')
assert.ok(sidebar.includes('prefetch={!isRootModuleHref(href) && intentTab === tab ? null : false}'), 'Module routes must prefetch only after intent')
assert.ok(sidebar.includes('window.history.pushState(null, "", href)'), 'Root tab links must update native history without an RSC request')
assert.ok(home.includes('window.history.pushState(null, "", href)'), 'In-page navigation must avoid redundant RSC requests')
assert.ok(!home.includes('router.refresh(') && !sidebar.includes('router.refresh('), 'Navigation must not force router refreshes')
assert.ok(!providers.includes('<ModuleEntryPreparation />'), 'The authenticated shell must not warm every inactive module')
assert.ok(loading.includes('data-navigation-loading="route"') && home.includes('data-navigation-loading="module"'), 'Route and lazy-module transitions need accessible loading feedback')
assert.ok(feedback.includes('!isRoleLoading && !roleError && !isAdmin'), 'Role-specific unread counts must wait for the live role and avoid expected 403 requests')

// UX polish 2026-10-15: entry feedback must never hide or delay content.
const template = read('app', 'template.tsx')
const globals = read('app', 'globals.css')
const familyPage = read('components', 'features', 'exams', 'ExamsFamilyPage.tsx')
const readingDashboard = read('components', 'features', 'reading', 'ReadingDashboard.tsx')
assert.ok(!template.includes('framer-motion') && !template.includes('opacity: 0'), 'Route template must not render server HTML hidden until hydration')
assert.ok(template.includes('ec-view-enter') && template.includes('rootModuleOf(pathname)'), 'Routes fade in with CSS; the root page animates its own tabs')
assert.ok(!home.includes('<AnimatePresence') && !home.includes('mode="wait"'), 'A root tab switch must not wait for an exit animation')
assert.ok(home.includes('const activeTab = rootModuleOf(pathname)'), 'The URL is the one source of the active root tab')
assert.ok(home.includes('min-h-full') && !home.includes('min-h-screen bg-surface'), 'Root tabs must not be taller than the workspace viewport')
const enter = globals.slice(globals.indexOf('.ec-view-enter {'), globals.indexOf('}', globals.indexOf('.ec-view-enter {')))
assert.ok(enter.includes('animation: ecViewEnter') && !/forwards|both|transform/.test(enter), 'View entry leaves no transform / stacking context behind')
assert.ok(/prefers-reduced-motion: reduce\)\s*\{\s*\.ec-view-enter\s*\{\s*animation: none/.test(globals), 'View entry is off under reduced motion')
assert.ok(!sidebar.includes('aria-disabled={pendingTab'), 'A pending navigation must not dim or disable the rest of the rail')
assert.ok(sidebar.includes('const shownTab = pendingTab ?? activeTab') && sidebar.includes('navItemClass(isShown, isCollapsed)'), 'The chosen module highlights immediately')
assert.ok(sidebar.includes('aria-current={isActive ? "page" : undefined}'), 'aria-current stays on the page actually shown')
assert.ok(familyPage.includes("window.history.replaceState(null, ''") && !familyPage.includes('router.replace('), 'Exams view tabs switch without a server round trip')
assert.ok(readingDashboard.includes('window.history.pushState(null, "", `${pathname}?${params.toString()}`)') && readingDashboard.includes('setOpening(true)'), 'Opening a reading answers the click at once, without a server round trip')

// Routing standardization 2026-11-01: old addresses keep working, by a temporary redirect (a rollback must never meet a cached permanent one).
assert.ok(proxy.includes("canonicalHref") && proxy.includes(', 307)'), 'The proxy redirects /?tab= to the canonical address, temporarily')
assert.ok(read('app', 'page.tsx').includes('<Home />') && read('components', 'landing', 'Home.tsx').includes('canonicalHref'), 'The root page covers a client-side arrival at an old address')

console.log('Navigation performance contracts: PASS')
