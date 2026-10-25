import { MockVerdeApi, VerdeApi } from "./services/verde-api.js?v=26";
import { PAGES, buildChartGeometry, escapeHtml, niceTime, normalizePage, safeResourceUrl, statusClass } from "./verde-ui.js?v=26";

const query = new URLSearchParams(window.location.search);
const requestedDelay = query.has("mockDelay") ? Number(query.get("mockDelay")) : 120;
const usingMock = query.get("api") === "mock";
const api = usingMock
  ? new MockVerdeApi({
    delay: Number.isFinite(requestedDelay) ? Math.min(Math.max(requestedDelay, 0), 10_000) : 120,
    shouldFail: query.get("mockError") === "1",
    online: query.get("mockOffline") !== "1"
  })
  : new VerdeApi();

const app = document.querySelector("#app");
const API_TIMEOUT_MS = 4_000;
const HISTORY_RANGES = ["Today", "24 Hours", "7 Days"];
const ALERT_FILTERS = ["All", "Active", "Acknowledged", "Resolved", "System"];
let activePage = pageFromHash();
let historyRange = "Today";
let historyMetric = null;
let alertFilter = "All";
let renderSequence = 0;
let renderedPage = null;
let lastSnapshot = null;
let deferredInstallPrompt = null;
const lastPageData = new Map();

const icon = (name) => ({ Dashboard: "⌂", Plants: "♧", History: "◷", Alerts: "♢", Settings: "⚙" })[name] ?? "•";
const safe = escapeHtml;

function pageFromHash() {
  try {
    return normalizePage(decodeURIComponent(window.location.hash.slice(1)));
  } catch {
    return "Dashboard";
  }
}

function withTimeout(promise, milliseconds = API_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => {
      const error = new Error("The VERDE service took too long to respond.");
      error.name = "TimeoutError";
      reject(error);
    }, milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer));
}

function connectionState(data) {
  if (!navigator.onLine) return { online: false, label: "Offline" };
  if (data?.stale) return { online: false, label: "Stale data" };
  if (!data?.online) return { online: false, label: data?.isMock ? "Mock offline" : "Backend unavailable" };
  return { online: true, label: data?.isMock ? "Mock data" : "Backend connected" };
}

function sourceLabel(data) {
  if (data?.stale) return "Last successful data — backend currently unavailable";
  return data?.isMock ? "Mock development data — no hardware connection" : "Live data from the local VERDE backend";
}

function renderHeader(data) {
  const connection = connectionState(data);
  return `<header class="topbar">
    <div class="brand"><img src="icons/icon.svg" alt="" /><div><h1>VERDE</h1><p>Hydroponics Monitoring System</p></div></div>
    <span class="online ${connection.online ? "" : "offline"}"><i></i>${safe(connection.label)}</span>
  </header>`;
}

function renderConnectionBanner(data) {
  if (data?.stale) {
    return `<aside class="connection-banner offline-banner" role="status"><div><b>Stale data</b><span>${safe(data.staleReason || "The backend is unavailable. Values may no longer be current.")}</span></div><button type="button" data-retry-connection>Try now</button></aside>`;
  }
  if (!navigator.onLine) {
    return `<aside class="connection-banner offline-banner" role="status"><div><b>Offline</b><span>${data?.isMock ? "Showing mock development data." : "Showing the last successful response when available."}</span></div><button type="button" data-retry-connection>Retry</button></aside>`;
  }
  if (!data.online) {
    return `<aside class="connection-banner offline-banner" role="status"><div><b>${data?.isMock ? "Mock adapter offline" : "Backend unavailable"}</b><span>${data?.isMock ? "Data is available for interface testing only." : "Live readings could not be refreshed."}</span></div><button type="button" data-retry-connection>Retry</button></aside>`;
  }
  return "";
}

function renderNav() {
  return `<nav aria-label="Main navigation">${PAGES.map((item) => {
    const current = item === activePage;
    return `<button class="nav-item ${current ? "active" : ""}" type="button" data-page="${item}"${current ? ' aria-current="page"' : ""}><span aria-hidden="true">${icon(item)}</span>${item}</button>`;
  }).join("")}</nav>`;
}

function renderShell(content, data) {
  return `<div class="app-shell">${renderHeader(data)}${renderConnectionBanner(data)}${content}${renderNav()}</div>`;
}

function renderCard(sensor) {
  const tone = statusClass(sensor.status);
  const marker = tone === "good" ? "✓" : tone === "danger" ? "!" : "·";
  return `<article class="sensor-card">
    <span class="sensor-icon" aria-hidden="true">${safe(sensor.icon)}</span>
    <div><h2>${safe(sensor.label)}</h2><p class="reading">${safe(sensor.value)}<small>${safe(sensor.unit)}</small></p>
    <span class="status ${tone}"><b aria-hidden="true">${marker}</b>${safe(sensor.status)}</span>
    ${sensor.detail ? `<p class="sensor-detail">${safe(sensor.detail)}</p>` : ""}</div>
  </article>`;
}

function bindNav() {
  document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => {
    const page = normalizePage(button.dataset.page);
    const nextHash = `#${encodeURIComponent(page)}`;
    if (window.location.hash === nextHash) {
      activePage = page;
      render();
    } else {
      window.location.hash = nextHash;
    }
  }));
  document.querySelector("[data-retry-connection]")?.addEventListener("click", () => render());
}

function showToast(message, tone = "good") {
  document.querySelector(".toast")?.remove();
  const toast = document.createElement("div");
  toast.className = `toast ${tone}`;
  toast.setAttribute("role", tone === "danger" ? "alert" : "status");
  toast.textContent = message;
  document.body.append(toast);
  window.setTimeout(() => toast.remove(), 5_000);
}

function showModal({ title, text, confirmText, onConfirm }) {
  const dialog = document.createElement("dialog");
  dialog.innerHTML = `<form method="dialog"><h2>${safe(title)}</h2><p>${safe(text)}</p><div class="dialog-actions"><button value="cancel" class="secondary">Cancel</button><button value="confirm" class="primary">${safe(confirmText)}</button></div></form>`;
  dialog.addEventListener("close", async () => {
    if (dialog.returnValue === "confirm") await onConfirm();
    dialog.remove();
  });
  document.body.append(dialog);
  dialog.showModal();
}

async function requestModeChange(data, sourceButton) {
  const selectedMode = data.requestedMode || data.mode;
  const nextMode = selectedMode === "Full Automation" ? "Semi-Automation" : "Full Automation";
  showModal({
    title: `Switch to ${nextMode}?`,
    text: data.isMock
      ? "This changes mock state only. It does not contact or control hardware."
      : "The Raspberry Pi backend will validate the request and keep its safety override active when required. Physical outputs remain disabled in this prototype.",
    confirmText: "Request change",
    onConfirm: async () => {
      if (sourceButton) sourceButton.disabled = true;
      try {
        const result = await withTimeout(api.requestModeChange(nextMode));
        await render();
        showToast(result.message);
      } catch (error) {
        showToast(error?.message || "The mode change could not be completed.", "danger");
      } finally {
        if (sourceButton?.isConnected) sourceButton.disabled = false;
      }
    }
  });
}

function bindModeButton(data) {
  const button = document.querySelector("[data-mode-button]");
  button?.addEventListener("click", () => requestModeChange(data, button));
}

function isInstalledPwa() {
  return window.matchMedia?.("(display-mode: standalone)").matches === true;
}

async function requestPwaInstallation(button) {
  if (isInstalledPwa()) {
    showToast("VERDE is already installed on this device.");
    return;
  }
  if (!window.isSecureContext) {
    showToast("Open VERDE through its private HTTPS address before installing.", "warn");
    return;
  }
  if (!deferredInstallPrompt) {
    showToast("In Android Chrome, open the menu and choose Install app or Add to Home screen.", "warn");
    return;
  }
  button.disabled = true;
  try {
    await deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    showToast(choice.outcome === "accepted" ? "VERDE installation accepted." : "Installation was cancelled.",
      choice.outcome === "accepted" ? "good" : "warn");
  } catch {
    showToast("The browser could not open the installation prompt. Use Chrome's Install app menu instead.", "warn");
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

function bindInstallButton() {
  const button = document.querySelector("[data-install-button]");
  button?.addEventListener("click", () => requestPwaInstallation(button));
}

function renderDashboard(data) {
  const time = niceTime(data.updatedAt);
  const fusionHeading = /^(High|Medium|Low)$/i.test(data.fusion.confidence)
    ? `${data.fusion.confidence} confidence`
    : data.fusion.confidence;
  const content = `<section class="overview" aria-label="System overview">
      <div><span class="meta">LAST SAMPLE</span><strong>${safe(time)}</strong></div>
      <button data-mode-button class="mode" type="button"><span aria-hidden="true">⚙</span><div><span class="meta">ACTIVE MODE</span><strong>${safe(data.mode)}</strong><small>Requested: ${safe(data.requestedMode || data.mode)}</small></div></button>
    </section>
    ${data.modeOverride ? `<aside class="safety-note" role="status"><b>Safety override active</b><span>${safe(data.modeOverride)}</span></aside>` : ""}
    <section class="section-heading"><div><h2>Live readings</h2><p>${safe(sourceLabel(data))}</p></div><time datetime="${safe(data.updatedAt)}">Updated ${safe(time)}</time></section>
    <section class="sensor-grid" aria-label="Sensor readings">${data.sensors.map(renderCard).join("")}</section>
    <section class="insight-list" aria-label="System insights">
      <article class="insight water"><span class="big-icon" aria-hidden="true">◈</span><div><p class="eyebrow">WATER QUALITY</p><h2>${safe(data.waterQuality.status)}</h2><p>${safe(data.waterQuality.summary)}</p></div></article>
      <article class="insight"><span class="big-icon" aria-hidden="true">♧</span><div><p class="eyebrow">PLANT MONITORING</p><h2>${safe(data.plant.condition)}</h2><p>${safe(data.plant.pestStatus)} · Vision ${safe(data.plant.status)}</p></div></article>
      <article class="insight"><span class="big-icon" aria-hidden="true">◉</span><div><p class="eyebrow">SENSOR-VISION FUSION</p><h2>${safe(fusionHeading)}</h2><p>${safe(data.fusion.reason)}</p></div></article>
    </section>`;
  app.innerHTML = renderShell(content, data);
  bindModeButton(data);
  bindNav();
}

function renderPlants(data) {
  const conditionTone = statusClass(data.plant.condition);
  const frameUrl = safeResourceUrl(data.plant.frameUrl, window.location.href);
  const camera = frameUrl
    ? `<figure class="camera-frame"><img src="${safe(frameUrl)}" alt="${data.plant.aiAnnotated ? "Latest AI-annotated plant detection frame" : "Latest camera frame"}" />${data.plant.aiAnnotated ? `<figcaption><b>Experimental AI overlay</b><span>Boxes and confidence come from the latest completed two-stage YOLO analysis.</span></figcaption>` : ""}</figure>`
    : `<section class="camera-placeholder" aria-label="Latest camera frame unavailable"><span aria-hidden="true">▧</span><h2>${data.plant.cameraStatus === "Faulty Camera" ? "Faulty Camera" : "Camera frame unavailable"}</h2><p>${safe(data.plant.cameraStatus || "No camera capture is available.")}</p></section>`;
  const pestKnown = typeof data.plant.pestDetected === "boolean";
  const classificationCards = (data.plant.classifications ?? []).map((classification) => {
    const detected = Number.isInteger(classification.count) && classification.count > 0;
    const tone = classification.label === "Wilting" ? "danger"
      : classification.label === "Yellowing" ? "warn" : "good";
    const count = classification.count === null
      ? "Unavailable"
      : `${classification.count} plant${classification.count === 1 ? "" : "s"}`;
    const confidence = classification.confidence ? `${classification.confidence} max confidence` : "No qualifying result";
    return `<article class="classification-card ${detected ? tone : "inactive"}"><span>${safe(classification.label)}</span><strong>${safe(count)}</strong><small>${safe(confidence)}</small></article>`;
  }).join("");
  const content = `<section class="page-title"><h2>Plant Monitoring</h2><p>${safe(sourceLabel(data))}</p></section>
    ${camera}
    <section class="plant-panel"><div class="panel-head"><span class="big-icon" aria-hidden="true">♧</span><div><p class="eyebrow">PLANT CONDITION</p><h2>Vision analysis</h2></div></div><div class="plant-result"><div><span class="status ${conditionTone}"><b aria-hidden="true">${conditionTone === "good" ? "✓" : conditionTone === "danger" ? "!" : "·"}</b>${safe(data.plant.status)}</span><strong>${safe(data.plant.condition)}</strong><small class="analysis-detail">${safe(data.plant.analysisDetail)}</small></div><div class="confidence"><span>Model confidence</span><strong>${safe(data.plant.confidence)}</strong></div></div><div class="classification-grid" aria-label="Latest per-class plant analysis">${classificationCards}</div><p class="classification-note">Harvest-Ready is an experimental visual indication and should be confirmed using growing-day records.</p></section>
    <section class="plant-panel"><div class="panel-head"><span class="big-icon" aria-hidden="true">◌</span><div><p class="eyebrow">PEST STATUS</p><h2>Presence detection only</h2></div></div><div class="notice ${pestKnown ? (data.plant.pestDetected ? "danger" : "good") : "warn"}"><b aria-hidden="true">${!pestKnown || data.plant.pestDetected ? "!" : "✓"}</b><div><strong>${safe(data.plant.pestStatus)}</strong><small>${safe(data.plant.pestDetail)}</small></div></div></section>
    <section class="plant-panel"><div class="panel-head"><span class="big-icon" aria-hidden="true">◉</span><div><p class="eyebrow">SENSOR-VISION FUSION</p><h2>Reliability indicator</h2></div></div><div class="fusion-result"><strong>${safe(data.fusion.confidence.toUpperCase())}</strong><p>${safe(data.fusion.reason)}</p></div></section>`;
  app.innerHTML = renderShell(content, data);
  bindNav();
}

function renderHistory(data, history) {
  historyMetric = history.metricKey;
  const chart = buildChartGeometry(history.values);
  const circles = chart.points.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="5" />`).join("");
  const area = chart.points.length
    ? `M${chart.points[0].x} 125 ${chart.points.map((point) => `L${point.x} ${point.y}`).join(" ")} L${chart.points.at(-1).x} 125 Z`
    : "";
  const unit = history.unit ? ` ${history.unit}` : "";
  const valueWithUnit = (value) => value === "—" ? value : `${value}${unit}`;
  const metricButtons = history.metrics.map((metric) => `<button type="button" data-history-metric="${safe(metric.key)}" class="metric-chip ${metric.key === history.metricKey ? "selected" : ""}" aria-pressed="${metric.key === history.metricKey}"><span>${safe(metric.label)}</span><small>${metric.sampleCount} sample${metric.sampleCount === 1 ? "" : "s"}</small></button>`).join("");
  const recent = history.samples.slice(-6).reverse().map((sample) => `<li><time datetime="${safe(sample.timestamp)}">${safe(sample.label)}</time><strong>${safe(valueWithUnit(sample.value))}</strong></li>`).join("");
  const incidentState = (incident) => incident.state === "RESOLVED" ? "Resolved" : incident.state === "ACKNOWLEDGED" ? "Acknowledged" : "Problem detected";
  const incidents = history.incidents.map((incident) => `<li class="incident-item ${incident.tone}"><span class="incident-marker" aria-hidden="true">${incident.state === "RESOLVED" ? "✓" : incident.state === "ACKNOWLEDGED" ? "◎" : "!"}</span><div><div class="incident-title-row"><strong>${safe(incident.title)}</strong><span>${incidentState(incident)}</span></div><p>${safe(incident.message)}</p><time datetime="${safe(incident.createdAt)}">${safe(niceTime(incident.createdAt))} · ${safe(relativeAlertTime(incident.createdAt))}</time></div></li>`).join("");
  const content = `<section class="page-title"><h2>History</h2><p>${safe(sourceLabel(data))}</p></section>
    <div class="filter-row" role="group" aria-label="History range">${HISTORY_RANGES.map((range) => `<button type="button" data-history-range="${range}" class="${range === history.range ? "selected" : ""}" aria-pressed="${range === history.range}">${range}</button>`).join("")}</div>
    <section class="metric-picker" aria-label="Sensor history metric">${metricButtons}</section>
    <section class="chart-card history-chart" style="--metric-color:${safe(history.color)}"><header class="chart-head"><div><p class="eyebrow">${safe(history.metricKey.replaceAll("_", " "))}</p><h2>${safe(history.title)}</h2><p>${safe(history.description)}</p></div><span class="sample-count">${history.sampleCount}<small>samples</small></span></header><svg viewBox="0 0 320 150" role="img" aria-label="${safe(history.description)}"><defs><linearGradient id="history-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--metric-color)" stop-opacity=".24"/><stop offset="1" stop-color="var(--metric-color)" stop-opacity="0"/></linearGradient></defs><path d="M20 125H304M20 90H304M20 55H304M20 20H304" stroke="#dbe6dd" stroke-dasharray="3"/>${area ? `<path d="${area}" fill="url(#history-fill)"/><path d="${chart.path}" fill="none" stroke="var(--metric-color)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><g fill="var(--surface)" stroke="var(--metric-color)" stroke-width="3">${circles}</g>` : ""}</svg>${history.values.length ? `<div class="chart-labels"><span>${safe(history.labels[0])}</span><span>${safe(history.labels[Math.floor(history.labels.length / 2)])}</span><span>${safe(history.labels.at(-1))}</span></div>` : `<div class="no-chart-data"><strong>No ${safe(history.title.toLowerCase())} data yet</strong><span>This sensor has no calibrated samples in the selected range.</span></div>`}</section>
    <section class="history-stats" aria-label="${safe(history.title)} summary"><article><span>Current</span><strong>${safe(valueWithUnit(history.current))}</strong></article><article><span>Average</span><strong>${safe(valueWithUnit(history.average))}</strong></article><article><span>Range</span><strong>${safe(valueWithUnit(history.minimum))} – ${safe(valueWithUnit(history.maximum))}</strong></article></section>
    <section class="recent-readings"><header><div><h2>Recent readings</h2><p>Newest valid samples in this range</p></div><span>${safe(history.unit || "Value")}</span></header>${recent ? `<ol>${recent}</ol>` : `<div class="empty-inline"><strong>No readings available</strong><span>Values will appear after the backend records valid measurements.</span></div>`}</section>
    <section class="incident-timeline"><header><div><h2>Problem timeline</h2><p>Detected problems and recorded recoveries</p></div><span>${history.incidents.length} event${history.incidents.length === 1 ? "" : "s"}</span></header>${incidents ? `<ol>${incidents}</ol>` : `<div class="empty-inline"><strong>No problem transitions in this range</strong><span>Sensor, vision, fusion, and system incidents will appear when they are detected or resolved.</span></div>`}</section>`;
  app.innerHTML = renderShell(content, data);
  document.querySelectorAll("[data-history-range]").forEach((button) => button.addEventListener("click", () => {
    historyRange = HISTORY_RANGES.includes(button.dataset.historyRange) ? button.dataset.historyRange : "Today";
    render();
  }));
  document.querySelectorAll("[data-history-metric]").forEach((button) => button.addEventListener("click", () => {
    historyMetric = button.dataset.historyMetric;
    render();
  }));
  bindNav();
}

function relativeAlertTime(iso) {
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return "Time unavailable";
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes === 0) return "Just now";
  if (minutes >= 1_440) return `${Math.floor(minutes / 1_440)}d ago`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ago`;
  return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
}

function renderAlerts(data, alerts) {
  const activeIncidents = new Map((data.incidents || []).map((incident) => [incident.issueKey, incident]));
  const loggedIssueKeys = new Set(alerts.map((alert) => alert.issueKey).filter(Boolean));
  const currentOnly = (data.incidents || []).filter((incident) => !loggedIssueKeys.has(incident.issueKey)).map((incident) => ({
    id: `current-${incident.issueKey}`,
    category: "current_incident",
    state: incident.state,
    source: incident.source,
    issueKey: incident.issueKey,
    tone: incident.severity === "critical" ? "danger" : "warn",
    icon: incident.state === "ACKNOWLEDGED" ? "◎" : incident.severity === "critical" ? "!" : "△",
    title: `${incident.source.replace(/\b\w/g, (letter) => letter.toUpperCase())} ${incident.state === "ACKNOWLEDGED" ? "acknowledged" : "problem"}`,
    message: incident.message,
    createdAt: incident.acknowledgedAt || incident.openedAt || data.updatedAt
  }));
  const alertRows = [...currentOnly, ...alerts];
  const counts = {
    Active: (data.incidents || []).filter((incident) => incident.state === "OPEN").length,
    Acknowledged: (data.incidents || []).filter((incident) => incident.state === "ACKNOWLEDGED").length,
    Resolved: alertRows.filter((alert) => alert.state === "RESOLVED").length
  };
  const filtered = alertRows.filter((alert) => alertFilter === "All"
    || (alertFilter === "Active" && alert.state === "OPEN" && activeIncidents.get(alert.issueKey)?.state === "OPEN")
    || (alertFilter === "Acknowledged" && alert.state === "ACKNOWLEDGED")
    || (alertFilter === "Resolved" && alert.state === "RESOLVED")
    || (alertFilter === "System" && !alert.state));
  const items = filtered.map((alert) => {
    const tone = ["good", "warn", "danger"].includes(alert.tone) ? alert.tone : "info";
    const label = tone === "danger" ? "Critical" : tone === "warn" ? "Warning" : tone === "good" ? "Resolved" : "System";
    const active = alert.issueKey ? activeIncidents.get(alert.issueKey) : null;
    const canAcknowledge = alert.state === "OPEN" && active?.state === "OPEN";
    return `<article class="alert-item ${tone}"><span class="alert-symbol" aria-hidden="true">${safe(alert.icon)}</span><div class="alert-copy"><div class="alert-title-row"><h2>${safe(alert.title)}</h2><span class="severity ${tone}">${label}</span></div><p>${safe(alert.message)}</p><div class="alert-meta"><time datetime="${safe(alert.createdAt)}">${safe(relativeAlertTime(alert.createdAt))}</time><span aria-hidden="true">•</span><time datetime="${safe(alert.createdAt)}">${safe(niceTime(alert.createdAt))}</time></div>${canAcknowledge ? `<button type="button" class="acknowledge-button" data-acknowledge-issue="${safe(alert.issueKey)}">Acknowledge</button>` : ""}</div></article>`;
  }).join("");
  const summary = `<section class="alert-summary" aria-label="Incident summary"><article class="danger"><span>Active</span><strong>${counts.Active}</strong></article><article class="warn"><span>Acknowledged</span><strong>${counts.Acknowledged}</strong></article><article class="good"><span>Resolved log</span><strong>${counts.Resolved}</strong></article></section>`;
  const filters = `<div class="filter-row alert-filters" role="group" aria-label="Filter alerts">${ALERT_FILTERS.map((filter) => `<button type="button" data-alert-filter="${filter}" class="${filter === alertFilter ? "selected" : ""}" aria-pressed="${filter === alertFilter}">${filter}</button>`).join("")}</div>`;
  const empty = `<article class="empty-list"><span aria-hidden="true">✓</span><div><h2>${alertRows.length ? `No ${safe(alertFilter.toLowerCase())} events` : "No events recorded"}</h2><p>${alertRows.length ? "Choose another filter to review the remaining system activity." : "New warnings, faults, recoveries, and system activity will appear here."}</p></div></article>`;
  const content = `<section class="page-title page-title-split"><div><h2>Alerts & activity</h2><p>${safe(sourceLabel(data))}</p></div><span class="read-only-label">Incident audit trail</span></section>${summary}${filters}<section class="alert-list" aria-live="polite">${items || empty}</section>`;
  app.innerHTML = renderShell(content, data);
  document.querySelectorAll("[data-alert-filter]").forEach((button) => button.addEventListener("click", () => {
    alertFilter = ALERT_FILTERS.includes(button.dataset.alertFilter) ? button.dataset.alertFilter : "All";
    renderAlerts(data, alerts);
  }));
  document.querySelectorAll("[data-acknowledge-issue]").forEach((button) => button.addEventListener("click", () => {
    showModal({
      title: "Acknowledge this incident?",
      text: "This records that the farmer has seen the warning. It does not mark the problem resolved and does not operate pumps, relays, or pesticides.",
      confirmText: "Acknowledge",
      onConfirm: async () => {
        button.disabled = true;
        try {
          await withTimeout(api.acknowledgeIssue(button.dataset.acknowledgeIssue));
          showToast("Incident acknowledged. It will remain active until the condition recovers.");
          await render();
        } catch (error) {
          showToast(error?.message || "The incident could not be acknowledged.", "danger");
        }
      }
    });
  }));
  bindNav();
}

function renderSettings(data) {
  const installed = isInstalledPwa();
  const installLabel = installed ? "Installed" : deferredInstallPrompt ? "Install app" : "Installation help";
  const content = `<section class="page-title"><h2>Settings</h2><p>${safe(sourceLabel(data))}</p></section>
    <section class="settings-list">
      <article><div><h2>Backend connection</h2><p>${data.isMock ? "Explicit development adapter; no hardware connection." : "Same-origin connection to the local VERDE service."}</p></div><span>${safe(data.settings.backendLabel)}</span></article>
      <article><div><h2>Install on this device</h2><p>Installation requires the private HTTPS address. Live readings still require a connection to the Raspberry Pi.</p></div><button data-install-button type="button" class="secondary"${installed ? " disabled" : ""}>${installLabel}</button></article>
      <article><div><h2>Operating mode</h2><p>Active: ${safe(data.mode)} · Requested: ${safe(data.requestedMode || data.mode)}. Safety validation is enforced by the backend.</p></div><button data-mode-button type="button" class="secondary">Change mode</button></article>
      <article><div><h2>Application version</h2><p>VERDE monitoring PWA</p></div><span>${safe(data.settings.version)}</span></article>
    </section>`;
  app.innerHTML = renderShell(content, data);
  bindModeButton(data);
  bindInstallButton();
  bindNav();
}

function unavailableSnapshot(error) {
  const now = new Date().toISOString();
  const sensors = [
    ["pH", "◈"], ["EC", "⌁"], ["TDS", "⋮"],
    ["Water Temperature", "♨"], ["Turbidity", "≋"], ["Ambient Humidity", "◌"]
  ].map(([label, sensorIcon]) => ({
    label, icon: sensorIcon, value: "—", unit: "", status: "Faulty Sensors",
    detail: "Backend unavailable; no reading detected."
  }));
  return {
    online: false, isMock: false, unavailable: true,
    unavailableReason: error?.message || "The backend is unavailable.",
    mode: "Unavailable", requestedMode: "Unavailable", modeOverride: null,
    updatedAt: now, systemStatus: "BACKEND UNAVAILABLE", sensors,
    waterQuality: { status: "Unavailable", summary: "The backend is unavailable, so water quality cannot be evaluated." },
    plant: { condition: "Unavailable", status: "Faulty Camera", pestDetected: null,
      pestStatus: "Unavailable", pestDetail: "Pest analysis is unavailable.", confidence: "Unavailable", classifications: [], frameUrl: null,
      lastCaptureAt: null, cameraStatus: "Faulty Camera" },
    fusion: { confidence: "Unavailable", reason: "The backend is unavailable." },
    alerts: [], settings: { backendConnected: false, backendLabel: "Backend unavailable", version: "Unavailable" }
  };
}

function renderLoading() {
  const content = `<section class="state-card" role="status"><span class="spinner" aria-hidden="true"></span><h2>Loading ${safe(activePage)}</h2><p>${usingMock ? "Reading explicit mock development data…" : "Connecting to the local VERDE backend…"}</p></section>`;
  app.innerHTML = `<div class="app-shell">${renderHeader({ online: navigator.onLine, isMock: usingMock })}${content}${renderNav()}</div>`;
  bindNav();
}

function renderError(error) {
  if (!usingMock) {
    renderUnavailable(unavailableSnapshot(error));
    return;
  }
  const isTimeout = error?.name === "TimeoutError";
  const content = `<section class="state-card error-card" role="alert"><span aria-hidden="true">!</span><h2>${isTimeout ? "Request timed out" : `Unable to load ${usingMock ? "mock data" : "the VERDE backend"}`}</h2><p>${safe(error?.message || "An unexpected error occurred.")}</p>${usingMock ? "" : "<p>Start the backend with this PWA as its web root, then retry. Live failures never fall back to fake readings.</p>"}<button id="retry-button" class="primary" type="button">Try again</button></section>`;
  app.innerHTML = `<div class="app-shell">${renderHeader({ online: false, isMock: usingMock })}${content}${renderNav()}</div>`;
  document.querySelector("#retry-button").addEventListener("click", render);
  bindNav();
}

function renderUnavailable(data) {
  if (activePage === "Plants") renderPlants(data);
  else if (activePage === "Settings") renderSettings(data);
  else renderDashboard(data);
}

async function render() {
  const sequence = ++renderSequence;
  if (!lastSnapshot || renderedPage !== activePage) renderLoading();
  try {
    const requests = [api.getSnapshot()];
    if (activePage === "History") requests.push(api.getHistory(historyRange, historyMetric));
    if (activePage === "Alerts") requests.push(api.getAlerts());
    let [data, pageData] = await withTimeout(Promise.all(requests));
    if (sequence !== renderSequence) return;
    const age = Date.now() - Date.parse(data.updatedAt);
    if (!data.isMock && Number.isFinite(age) && age > 65_000) {
      data = { ...data, online: false, stale: true, staleReason: `The last backend sample is ${Math.max(1, Math.floor(age / 1_000))} seconds old.` };
    }
    lastSnapshot = data;
    if (pageData !== undefined) lastPageData.set(activePage, pageData);

    if (activePage === "Plants") renderPlants(data);
    else if (activePage === "History") renderHistory(data, pageData);
    else if (activePage === "Alerts") renderAlerts(data, pageData);
    else if (activePage === "Settings") renderSettings(data);
    else renderDashboard(data);
    renderedPage = activePage;
  } catch (error) {
    if (sequence !== renderSequence) return;
    const cachedPageData = lastPageData.get(activePage);
    const pageNeedsData = activePage === "History" || activePage === "Alerts";
    if (lastSnapshot && (!pageNeedsData || cachedPageData !== undefined)) {
      const staleData = { ...lastSnapshot, online: false, stale: true, staleReason: error?.message || "The backend could not be refreshed." };
      if (activePage === "Plants") renderPlants(staleData);
      else if (activePage === "History") renderHistory(staleData, cachedPageData);
      else if (activePage === "Alerts") renderAlerts(staleData, cachedPageData);
      else if (activePage === "Settings") renderSettings(staleData);
      else renderDashboard(staleData);
      renderedPage = activePage;
    } else {
      const unavailableData = unavailableSnapshot(error);
      renderUnavailable(unavailableData);
      renderedPage = activePage;
    }
  }
}

window.addEventListener("hashchange", () => {
  activePage = pageFromHash();
  render();
});
window.addEventListener("online", () => { showToast("Network connection restored. Refreshing live data."); render(); });
window.addEventListener("offline", render);
document.addEventListener("visibilitychange", () => { if (!document.hidden) render(); });
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  if (activePage === "Settings" && lastSnapshot) renderSettings(lastSnapshot);
});
window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  showToast("VERDE was installed successfully.");
  if (activePage === "Settings" && lastSnapshot) renderSettings(lastSnapshot);
});

if (!window.location.hash) window.history.replaceState(null, "", "#Dashboard");
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("./service-worker.js?v=27", { updateViaCache: "none" });
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            showToast("A VERDE update is ready. Close and reopen the app to use it.");
          }
        });
      });
    } catch {
      showToast("Offline installation is unavailable in this browser.", "warn");
    }
  });
}

render();
window.setInterval(() => {
  if (!document.hidden && !document.querySelector("dialog[open]")) render();
}, 5_000);
