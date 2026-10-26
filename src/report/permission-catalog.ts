// Permission catalog — the reference asset behind the report's permissions
// section. A static, hand-authored map from each Chrome manifest permission to a
// layperson explanation, the official Google documentation URL, and Chrome's
// verbatim install-time warning (when one exists). Seeded from the permissions
// list page (fetched 2026-06-17) plus the per-permission detail/concept pages:
//   https://developer.chrome.com/docs/extensions/reference/permissions-list
//
// This module is pure static data + pure functions. It contains NO LLM text and
// reads nothing at runtime, so the permissions section stays deterministic and
// identical across every methodology (it is consumed only by buildPermissions,
// which every arm shares). Unknown / future permissions degrade gracefully via
// describePermission's fallback rather than breaking a report.

import type { PermissionRow } from "./contract.ts";

const DOC_BASE = "https://developer.chrome.com";
const API = `${DOC_BASE}/docs/extensions/reference/api`;
const CONCEPT = `${DOC_BASE}/docs/extensions/develop/concepts`;
/** Permissions with no dedicated detail page link back to the list page. */
export const PERMISSIONS_LIST_URL = `${DOC_BASE}/docs/extensions/reference/permissions-list`;

export interface PermissionInfo {
  /** One line, layperson: what this permission lets the extension do. */
  summary: string;
  /** Absolute URL to the Google doc (detail page when one exists, else the list). */
  doc_url: string;
  /** Chrome's install-time warning, verbatim, or null when Chrome shows none. */
  install_warning: string | null;
}

/**
 * One entry per permission on the list page. `doc_url` points at the detail page
 * when the list links one, else PERMISSIONS_LIST_URL. `install_warning` is copied
 * verbatim from the list page (Chrome's own layperson wording) or null.
 */
export const PERMISSION_CATALOG: Record<string, PermissionInfo> = {
  "accessibilityFeatures.modify": {
    summary: "Change Chrome's accessibility settings (such as high contrast or screen-reader options).",
    doc_url: `${API}/accessibilityFeatures`,
    install_warning: "Change your accessibility settings.",
  },
  "accessibilityFeatures.read": {
    summary: "Read Chrome's accessibility settings.",
    doc_url: `${API}/accessibilityFeatures`,
    install_warning: "Read your accessibility settings.",
  },
  activeTab: {
    summary: "Temporarily access the current tab when you click the extension — no standing access to your browsing.",
    doc_url: `${CONCEPT}/activeTab`,
    install_warning: null,
  },
  alarms: {
    summary: "Schedule code to run at set times or intervals (timers).",
    doc_url: `${API}/alarms`,
    install_warning: null,
  },
  audio: {
    summary: "See and control the device's audio input/output devices.",
    doc_url: `${API}/audio`,
    install_warning: null,
  },
  background: {
    summary: "Keep running in the background and start with Chrome.",
    doc_url: PERMISSIONS_LIST_URL,
    install_warning: null,
  },
  bookmarks: {
    summary: "Read and change your bookmarks.",
    doc_url: `${API}/bookmarks`,
    install_warning: "Read and change your bookmarks.",
  },
  browsingData: {
    summary: "Clear your browsing data (history, cache, cookies, and more).",
    doc_url: `${API}/browsingData`,
    install_warning: null,
  },
  certificateProvider: {
    summary: "Provide TLS client certificates (typically on managed/enterprise devices).",
    doc_url: `${API}/certificateProvider`,
    install_warning: null,
  },
  clipboardRead: {
    summary: "Read whatever you copy and paste.",
    doc_url: PERMISSIONS_LIST_URL,
    install_warning: "Read data you copy and paste.",
  },
  clipboardWrite: {
    summary: "Write to your clipboard (change what you copy and paste).",
    doc_url: PERMISSIONS_LIST_URL,
    install_warning: "Modify data you copy and paste.",
  },
  contentSettings: {
    summary: "Change per-site browser settings (cookies, JavaScript, images, location, and more).",
    doc_url: `${API}/contentSettings`,
    install_warning: "Change your settings that control websites' access to features such as cookies, JavaScript, plugins, geolocation, microphone, camera etc.",
  },
  contextMenus: {
    summary: "Add items to Chrome's right-click context menu.",
    doc_url: `${API}/contextMenus`,
    install_warning: null,
  },
  cookies: {
    summary: "Read and change the cookies stored for the sites you visit.",
    doc_url: `${API}/cookies`,
    install_warning: null,
  },
  debugger: {
    summary: "Use the Chrome debugger to inspect and control any page — a very broad capability that can read and change everything you do on the web.",
    doc_url: `${API}/debugger`,
    install_warning: "Access the page debugger backend; read and change all your data on all websites.",
  },
  declarativeContent: {
    summary: "Act on pages based on their URL/content without reading the page itself.",
    doc_url: `${API}/declarativeContent`,
    install_warning: null,
  },
  declarativeNetRequest: {
    summary: "Block or modify network requests on any page using declared rules.",
    doc_url: `${API}/declarativeNetRequest`,
    install_warning: "Block content on any page.",
  },
  declarativeNetRequestWithHostAccess: {
    summary: "Block or modify network requests on sites you grant host access to.",
    doc_url: `${API}/declarativeNetRequest`,
    install_warning: null,
  },
  declarativeNetRequestFeedback: {
    summary: "See which of its request rules matched your traffic (reveals your browsing).",
    doc_url: `${API}/declarativeNetRequest`,
    install_warning: "Read your browsing history.",
  },
  dns: {
    summary: "Resolve domain names (look up DNS records).",
    doc_url: PERMISSIONS_LIST_URL,
    install_warning: null,
  },
  desktopCapture: {
    summary: "Capture the contents of your screen, windows, or tabs.",
    doc_url: `${API}/desktopCapture`,
    install_warning: "Capture content of your screen.",
  },
  documentScan: {
    summary: "Access connected document scanners.",
    doc_url: `${API}/documentScan`,
    install_warning: null,
  },
  downloads: {
    summary: "Start, monitor, and manage your file downloads.",
    doc_url: `${API}/downloads`,
    install_warning: "Manage your downloads.",
  },
  "downloads.open": {
    summary: "Open files you have downloaded.",
    doc_url: `${API}/downloads#method-open`,
    install_warning: "Manage your downloads.",
  },
  "downloads.ui": {
    summary: "Customize the downloads user interface.",
    doc_url: `${API}/downloads#method-setUiOptions`,
    install_warning: "Manage your downloads.",
  },
  "enterprise.deviceAttributes": {
    summary: "Read managed-device attributes (enterprise/managed devices only).",
    doc_url: `${API}/enterprise/deviceAttributes`,
    install_warning: null,
  },
  "enterprise.hardwarePlatform": {
    summary: "Read the device's hardware platform info (enterprise/managed devices only).",
    doc_url: `${API}/enterprise/hardwarePlatform`,
    install_warning: null,
  },
  "enterprise.networkingAttributes": {
    summary: "Read the device's network details (enterprise/managed devices only).",
    doc_url: `${API}/enterprise/networkingAttributes`,
    install_warning: null,
  },
  "enterprise.platformKeys": {
    summary: "Manage device certificates/keys (enterprise/managed devices only).",
    doc_url: `${API}/enterprise/platformKeys`,
    install_warning: null,
  },
  favicon: {
    summary: "Read the site icons (favicons) of the websites you visit.",
    doc_url: `${DOC_BASE}/docs/extensions/how-to/ui/favicons`,
    install_warning: "Read the icons of the websites you visit.",
  },
  fileBrowserHandler: {
    summary: "Add handlers to the ChromeOS file browser.",
    doc_url: `${API}/fileBrowserHandler`,
    install_warning: null,
  },
  fileSystemProvider: {
    summary: "Provide a virtual file system to ChromeOS.",
    doc_url: `${API}/fileSystemProvider`,
    install_warning: null,
  },
  fontSettings: {
    summary: "Read and change Chrome's font settings.",
    doc_url: `${API}/fontSettings`,
    install_warning: null,
  },
  gcm: {
    summary: "Send and receive messages through Google Cloud Messaging / Firebase.",
    doc_url: `${API}/gcm`,
    install_warning: null,
  },
  geolocation: {
    summary: "Detect your physical location.",
    doc_url: PERMISSIONS_LIST_URL,
    install_warning: "Detect your physical location.",
  },
  history: {
    summary: "Read and change your browsing history across signed-in devices.",
    doc_url: `${API}/history`,
    install_warning: "Read and change your browsing history on all signed-in devices.",
  },
  identity: {
    summary: "Get OAuth2 access tokens to sign you in to Google or other accounts.",
    doc_url: `${API}/identity`,
    install_warning: null,
  },
  "identity.email": {
    summary: "Know the email address of the account you are signed in with.",
    doc_url: `${API}/identity`,
    install_warning: "Know your email address.",
  },
  idle: {
    summary: "Detect when the machine is idle, active, or locked.",
    doc_url: `${API}/idle`,
    install_warning: null,
  },
  loginState: {
    summary: "Read whether the session is a regular profile or the sign-in screen (ChromeOS).",
    doc_url: `${API}/loginState`,
    install_warning: null,
  },
  management: {
    summary: "See, enable, disable, and uninstall your other extensions, apps, and themes.",
    doc_url: `${API}/management`,
    install_warning: "Manage your apps, extensions, and themes.",
  },
  nativeMessaging: {
    summary: "Exchange messages with cooperating native programs installed on your computer.",
    doc_url: `${CONCEPT}/native-messaging`,
    install_warning: "Communicate with cooperating native applications.",
  },
  notifications: {
    summary: "Show you desktop notifications.",
    doc_url: `${API}/notifications`,
    install_warning: "Display notifications.",
  },
  offscreen: {
    summary: "Run an invisible document to use DOM-dependent APIs from the background.",
    doc_url: `${API}/offscreen`,
    install_warning: null,
  },
  pageCapture: {
    summary: "Save the full contents of any page you visit (as MHTML).",
    doc_url: `${API}/pageCapture`,
    install_warning: "Read and change all your data on all websites.",
  },
  platformKeys: {
    summary: "Use client certificates and keys managed by the platform.",
    doc_url: `${API}/platformKeys`,
    install_warning: null,
  },
  power: {
    summary: "Keep the screen or system awake (override power management).",
    doc_url: `${API}/power`,
    install_warning: null,
  },
  printerProvider: {
    summary: "Provide printers to Chrome's print system.",
    doc_url: `${API}/printerProvider`,
    install_warning: null,
  },
  printing: {
    summary: "Send print jobs to printers.",
    doc_url: `${API}/printing`,
    install_warning: null,
  },
  printingMetrics: {
    summary: "Read your printing usage history/statistics.",
    doc_url: `${API}/printingMetrics`,
    install_warning: null,
  },
  privacy: {
    summary: "Read and change privacy-related browser settings.",
    doc_url: `${API}/privacy`,
    install_warning: "Change your privacy-related settings.",
  },
  processes: {
    summary: "Read information about Chrome's processes (tabs, memory, CPU).",
    doc_url: PERMISSIONS_LIST_URL,
    install_warning: null,
  },
  proxy: {
    summary: "Control how Chrome connects to the internet (proxy settings) — can route all your traffic.",
    doc_url: `${API}/proxy`,
    install_warning: "Read and change all your data on all websites.",
  },
  readingList: {
    summary: "Read and change the entries in your reading list.",
    doc_url: `${API}/readingList`,
    install_warning: "Read and change entries in the reading list.",
  },
  runtime: {
    summary: "Use core extension runtime features (messaging, lifecycle).",
    doc_url: `${API}/runtime`,
    install_warning: null,
  },
  scripting: {
    summary: "Inject and run its own scripts and styles into web pages.",
    doc_url: `${API}/scripting`,
    install_warning: null,
  },
  search: {
    summary: "Run searches using the default search provider.",
    doc_url: `${API}/search`,
    install_warning: null,
  },
  sessions: {
    summary: "See and restore recently closed tabs and other devices' open tabs.",
    doc_url: `${API}/sessions`,
    install_warning: null,
  },
  sidePanel: {
    summary: "Show its own content in the browser's side panel.",
    doc_url: `${API}/sidePanel`,
    install_warning: null,
  },
  storage: {
    summary: "Store and retrieve its own data in the browser.",
    doc_url: `${API}/storage`,
    install_warning: null,
  },
  "system.cpu": {
    summary: "Read CPU information about the device.",
    doc_url: `${API}/system/cpu`,
    install_warning: null,
  },
  "system.display": {
    summary: "Read information about connected displays.",
    doc_url: `${API}/system/display`,
    install_warning: null,
  },
  "system.memory": {
    summary: "Read the device's memory information.",
    doc_url: `${API}/system/memory`,
    install_warning: null,
  },
  "system.storage": {
    summary: "Read storage-device information and eject removable storage.",
    doc_url: `${API}/system/storage`,
    install_warning: "Identify and eject storage devices.",
  },
  tabCapture: {
    summary: "Capture the visible content (and audio) of a tab.",
    doc_url: `${API}/tabCapture`,
    install_warning: "Read and change all your data on all websites.",
  },
  tabGroups: {
    summary: "View and manage your tab groups.",
    doc_url: `${API}/tabGroups`,
    install_warning: "View and manage your tab groups.",
  },
  tabs: {
    summary: "Read details about your open tabs, including their URLs and titles.",
    doc_url: `${API}/tabs`,
    install_warning: "Read your browsing history.",
  },
  topSites: {
    summary: "Read the list of your most frequently visited websites.",
    doc_url: `${API}/topSites`,
    install_warning: "Read a list of your most frequently visited websites.",
  },
  tts: {
    summary: "Speak text aloud using text-to-speech.",
    doc_url: `${API}/tts`,
    install_warning: null,
  },
  ttsEngine: {
    summary: "Provide a text-to-speech voice — receives all text spoken by other extensions.",
    doc_url: `${API}/ttsEngine`,
    install_warning: "Read all text spoken using synthesized speech.",
  },
  unlimitedStorage: {
    summary: "Store an unlimited amount of data in the browser.",
    doc_url: `${CONCEPT}/storage-and-cookies`,
    install_warning: null,
  },
  userScripts: {
    summary: "Register and run arbitrary user-provided scripts on web pages.",
    doc_url: `${API}/userScripts`,
    install_warning: null,
  },
  vpnProvider: {
    summary: "Implement a VPN connection (ChromeOS) — can route all your traffic.",
    doc_url: `${API}/vpnProvider`,
    install_warning: null,
  },
  wallpaper: {
    summary: "Set the ChromeOS desktop wallpaper.",
    doc_url: `${API}/wallpaper`,
    install_warning: null,
  },
  webAuthenticationProxy: {
    summary: "Intercept and handle web authentication (WebAuthn) requests for any site.",
    doc_url: `${API}/webAuthenticationProxy`,
    install_warning: "Read and change all your data on all websites.",
  },
  webNavigation: {
    summary: "See navigation events as you move between pages (reveals your browsing).",
    doc_url: `${API}/webNavigation`,
    install_warning: "Read your browsing history.",
  },
  webRequest: {
    summary: "Observe network requests on the sites you grant access to.",
    doc_url: `${API}/webRequest`,
    install_warning: null,
  },
  webRequestBlocking: {
    summary: "Block or modify network requests synchronously (legacy blocking webRequest).",
    doc_url: `${API}/webRequest#permissions`,
    install_warning: null,
  },
};

/** Catalog lookup with a safe fallback for unknown / future permissions. */
export function describePermission(permission: string): PermissionInfo {
  return (
    PERMISSION_CATALOG[permission] ?? {
      summary: "Grants a capability not in our catalog — see the Chrome permissions documentation.",
      doc_url: PERMISSIONS_LIST_URL,
      install_warning: null,
    }
  );
}

// ---------------------------------------------------------------------------
// "How it's used in the code" — deterministic, plain-language translation of the
// static call-site evidence. No LLM: it maps the observed API methods on a row
// to canned phrases, so the same evidence always produces the same wording.
// ---------------------------------------------------------------------------

/**
 * Plain-language action for a specific observed API method, keyed by the method
 * tail (the call stripped of any `chrome.`/`browser.` prefix, e.g.
 * "cookies.getAll"). High-signal methods of the permissions we risk-categorize;
 * anything unmapped falls back to a generic per-permission phrase.
 */
const API_PHRASES: Record<string, string> = {
  "cookies.getAll": "reads all your cookies",
  "cookies.get": "reads cookies",
  "cookies.set": "creates or changes cookies",
  "cookies.remove": "deletes cookies",
  "tabs.query": "lists your open tabs",
  "tabs.create": "opens new tabs",
  "tabs.update": "navigates or changes tabs",
  "tabs.executeScript": "runs code inside your tabs",
  "tabs.captureVisibleTab": "captures screenshots of your tabs",
  "scripting.executeScript": "runs its own code inside web pages",
  "scripting.insertCSS": "injects styles into web pages",
  "scripting.registerContentScripts": "registers scripts to run on web pages",
  "webRequest.onBeforeRequest": "inspects your network requests",
  "webRequest.onBeforeSendHeaders": "inspects/edits your request headers",
  "webRequest.onHeadersReceived": "inspects response headers",
  "storage.local.get": "reads its locally stored data",
  "storage.local.set": "writes to its local storage",
  "storage.sync.get": "reads its synced storage",
  "storage.sync.set": "writes to its synced storage",
  "history.search": "reads your browsing history",
  "history.deleteUrl": "deletes browsing history entries",
  "downloads.download": "downloads files",
  "downloads.search": "reads your download history",
  "management.getAll": "lists your installed extensions",
  "management.setEnabled": "enables or disables other extensions",
  "management.uninstall": "uninstalls other extensions",
  "proxy.settings.set": "changes your proxy (traffic-routing) settings",
  "debugger.attach": "attaches the debugger to a page",
  "debugger.sendCommand": "sends debugger commands to a page",
  "nativeMessaging.connectNative": "talks to a native program on your computer",
  "runtime.connectNative": "talks to a native program on your computer",
  "notifications.create": "shows you notifications",
  "geolocation.getCurrentPosition": "reads your physical location",
  "bookmarks.getTree": "reads your bookmarks",
  "bookmarks.create": "creates bookmarks",
  "webNavigation.onCompleted": "watches the pages you navigate to",
};

/** Strip a leading `chrome.`/`browser.`/`window.` so the key matches API_PHRASES. */
function methodTail(api: string): string {
  return api.replace(/^(?:window\.)?(?:chrome|browser)\./, "");
}

/**
 * A plain-language description of how the permission is exercised, derived purely
 * from the static call-site evidence on the row. Honest about the static limits:
 * unused/undetermined statuses say so explicitly.
 */
export function describeUsage(row: PermissionRow): string {
  if (row.status === "unused") {
    return "Declared, but no use of it was found in the bundled code.";
  }
  if (row.status === "undetermined") {
    return "Declared; static analysis could not confirm where it is used (e.g. dynamic or obfuscated code).";
  }
  // status === "used": translate the distinct observed methods, in first-seen
  // order, deduped. Unmapped methods collapse into a single generic phrase.
  const phrases: string[] = [];
  const seen = new Set<string>();
  let hasGeneric = false;
  for (const u of row.usage) {
    const phrase = API_PHRASES[methodTail(u.api)];
    if (phrase) {
      if (!seen.has(phrase)) {
        seen.add(phrase);
        phrases.push(phrase);
      }
    } else {
      hasGeneric = true;
    }
  }
  if (hasGeneric || phrases.length === 0) phrases.push(`uses the \`${row.permission}\` API`);
  const sites = `${row.total_usage} call site${row.total_usage === 1 ? "" : "s"}`;
  // Capitalize the first phrase for a sentence-like cell.
  const joined = phrases.join("; ");
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)} (${sites}).`;
}

// ---------------------------------------------------------------------------
// Host access — host match patterns are not API permissions and are not on the
// list page, so describe them with a small dedicated helper.
// ---------------------------------------------------------------------------

const BROAD_HOST_PATTERNS = new Set(["<all_urls>", "*://*/*", "http://*/*", "https://*/*", "*://*"]);

/** Plain-language note about a manifest's host access scope. */
export function describeHosts(hosts: { required: string[]; optional: string[] }): string {
  const all = [...hosts.required, ...hosts.optional];
  if (all.length === 0) return "No host access is requested — the extension cannot read or change data on websites.";
  if (all.some((h) => BROAD_HOST_PATTERNS.has(h))) {
    return "Can read and change your data on ALL websites you visit.";
  }
  const shown = hosts.required.slice(0, 6).join(", ");
  const more = hosts.required.length > 6 ? `, and ${hosts.required.length - 6} more` : "";
  const opt = hosts.optional.length > 0 ? ` Optional access to ${hosts.optional.length} more site(s).` : "";
  return `Can read and change your data on specific sites: ${shown}${more}.${opt}`;
}
