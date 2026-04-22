export const DEFAULT_INSPECTOR_HOTKEYS = {
  accept_classification: 'a',
  reject_classification: 'r',
  toggle_shortcut_help: 'h',
};

export const DEFAULT_PANEL_LAYOUT = {
  part_list: { is_open: true, width_px: 320, height_px: 420, orientation: 'vertical' },
  inspector: { is_open: true, width_px: 360, height_px: 420, orientation: 'vertical' },
  mpr_controls: { is_open: true, width_px: 360, height_px: 360, orientation: 'vertical' },
};

export const PANEL_LAYOUT_KEYS = ['part_list', 'inspector', 'mpr_controls'];

export function normalizePanelDimension(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

export function normalizePanelLayout(candidate) {
  const safeCandidate = candidate && typeof candidate === 'object' ? candidate : {};
  return PANEL_LAYOUT_KEYS.reduce((acc, key) => {
    const defaults = DEFAULT_PANEL_LAYOUT[key];
    const current = safeCandidate[key] && typeof safeCandidate[key] === 'object' ? safeCandidate[key] : {};
    const orientation = String(current.orientation || defaults.orientation).toLowerCase();
    acc[key] = {
      is_open: current.is_open !== false,
      width_px: normalizePanelDimension(current.width_px, 220, 1200, defaults.width_px),
      height_px: normalizePanelDimension(current.height_px, 220, 1400, defaults.height_px),
      orientation: orientation === 'horizontal' ? 'horizontal' : 'vertical',
    };
    return acc;
  }, {});
}

export function normalizeInspectorHotkeys(candidate) {
  const normalized = { ...DEFAULT_INSPECTOR_HOTKEYS };
  if (!candidate || typeof candidate !== 'object') return normalized;
  Object.entries(DEFAULT_INSPECTOR_HOTKEYS).forEach(([binding, fallback]) => {
    const raw = typeof candidate[binding] === 'string' ? candidate[binding].trim().toLowerCase() : fallback;
    normalized[binding] = /^[a-z0-9]$/.test(raw) ? raw : fallback;
  });
  return normalized;
}
