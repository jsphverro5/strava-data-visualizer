// ── API client ────────────────────────────────────────────────────────────────

async function apiFetch(path, params = {}) {
  const url = new URL(API_BASE + path);
  Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  return res.json();
}

const API = {
  activityTypes:    ()             => apiFetch("/activities/types"),
  activities:       (type)         => apiFetch("/activities", { type, limit: 2000 }),
  activityTrack:    (id)           => apiFetch(`/activities/${id}/track`),
  heatmap:          (type)         => apiFetch("/heatmap", { type }),
  routes:           ()             => apiFetch("/routes"),
  routeTrack:       (id)           => apiFetch(`/routes/${id}/track`),
  routeActivities:  (id)           => apiFetch(`/routes/${id}/activities`),
  summary:          ()             => apiFetch("/stats/summary"),
  timeline:         (type)         => apiFetch("/stats/timeline", { type }),
  segments:         (q, starred)   => apiFetch("/segments", { q: q||undefined, starred: starred?"1":undefined }),
  segmentEfforts:   (uuid)         => apiFetch(`/segments/${uuid}/efforts`),
  segmentTrack:     (uuid)         => apiFetch(`/segments/${uuid}/track`),
  scrambles:        ()             => apiFetch("/scrambles"),
  scrambleTrack:    (id)           => apiFetch(`/scrambles/${id}/track`),
};
