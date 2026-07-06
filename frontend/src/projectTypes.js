// Centralized project type display metadata.
// Update these labels when a deployment needs different user-facing names for PT1/PT2/PT3.
export const PROJECT_TYPE_OPTIONS = [
  { value: 'PT1', label: 'PT1 — External Multi-View', shortLabel: 'PT1' },
  { value: 'PT2', label: 'PT2 — 3D Slice Review', shortLabel: 'PT2' },
  { value: 'PT3', label: 'PT3 — Advanced 3D Slice Review', shortLabel: 'PT3' },
];

export const DEFAULT_PROJECT_TYPE = PROJECT_TYPE_OPTIONS[0].value;

export function getProjectTypeLabel(projectType, { short = false } = {}) {
  const option = PROJECT_TYPE_OPTIONS.find((item) => item.value === projectType);
  if (!option) return projectType || DEFAULT_PROJECT_TYPE;
  return short ? option.shortLabel : option.label;
}
