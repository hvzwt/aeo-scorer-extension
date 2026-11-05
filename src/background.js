// Opens the side panel from the toolbar icon (the panel lives outside the page,
// so reloading or navigating the tab does not reset it) and runs scheduled
// AI visibility checks.
import { loadVis, runTracker, runMetrics, saveRun } from "./visibility.js";

const ALARM = "vis-run";
const LOCK = "vis:running";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("AEO Scorer: could not set panel behavior", err));
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM) return;
  const { settings, [LOCK]: lock } = await chrome.storage.local.get(["settings", LOCK]);
  const { project } = await loadVis();
  if (!settings?.apiKey || !project?.prompts?.length || project.schedule === "off") return;
  if (lock && Date.now() - lock < 20 * 60_000) return; // a run is already going
  await chrome.storage.local.set({ [LOCK]: Date.now() });
  // Extension API calls keep the service worker alive during long requests.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  try {
    const { results, cost } = await runTracker({ apiKey: settings.apiKey, model: settings.model, project });
    if (results.length) {
      const metrics = runMetrics(project, results);
      await saveRun({ at: Date.now(), model: settings.model, results, metrics, cost, scheduled: true });
      chrome.action.setBadgeBackgroundColor({ color: "#1a73e8" });
      chrome.action.setBadgeText({ text: `${metrics.brand.mentionRate}%` });
      chrome.action.setTitle({ title: `AEO Scorer: ${project.brand} mentioned in ${metrics.brand.mentionRate}% of AI answers (scheduled run)` });
    }
  } catch (e) {
    console.error("AEO Scorer: scheduled visibility run failed", e);
  } finally {
    clearInterval(keepAlive);
    await chrome.storage.local.remove(LOCK);
  }
});
