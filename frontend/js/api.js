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
  scramblesNearby:  ()             => apiFetch("/scrambles/nearby"),
  scrambleVisits:   (id)           => apiFetch(`/scrambles/${id}/visits`),
  checklist:        ()             => apiFetch("/checklist"),
  setChecklist:     (id, done)     => fetch(`${API_BASE}/checklist/${id}`, {
                                        method: "POST",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({ done }),
                                      }).then(r => r.json()),
  activityProfile:  (id)           => apiFetch(`/activities/${id}/profile`),
  yearStats:        (type)         => apiFetch("/stats/years", { type }),
  bigDays:          ()             => apiFetch("/bigdays", { limit: 75 }),
  renameRoute:      (id, name)     => fetch(`${API_BASE}/routes/${id}/name`, {
                                        method: "POST",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({ name }),
                                      }).then(r => r.json()),
};
