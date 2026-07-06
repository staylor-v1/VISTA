export const UI_SECTION_GROUPS = [
  {
    id: 'main',
    label: 'Primary workspace tabs',
    description: 'Show or hide top-level project workspace areas.',
    sections: [
      { key: 'main.analyze', label: 'Analyze tab' },
      { key: 'main.inspection', label: 'Inspection tab' },
      { key: 'main.report', label: 'Report tab' },
    ],
  },
  {
    id: 'project_data',
    label: 'Project Data tools',
    description: 'Expose specialized data-management subtabs only when a project needs them.',
    sections: [
      { key: 'project_data.images_to_parts', label: 'Images to Parts subtab' },
      { key: 'project_data.overlays', label: 'Overlays subtab' },
      { key: 'project_data.metadata', label: 'Metadata subtab' },
      { key: 'project_data.batches', label: 'Batches subtab' },
      { key: 'project_data.remove_images', label: 'Unload Images subtab' },
      { key: 'project_data.recently_deleted', label: 'Recently Deleted subtab' },
      { key: 'project_data.data_validation', label: 'Data Validation panel' },
    ],
  },
];

export const UI_SECTION_DEFAULTS = UI_SECTION_GROUPS
  .flatMap((group) => group.sections)
  .reduce((acc, section) => ({ ...acc, [section.key]: true }), {});

export function normalizeUiSections(config = {}) {
  const source = config?.ui_sections && typeof config.ui_sections === 'object' ? config.ui_sections : {};
  return Object.entries(UI_SECTION_DEFAULTS).reduce((acc, [key, defaultValue]) => {
    acc[key] = source[key] === undefined ? defaultValue : source[key] !== false;
    return acc;
  }, {});
}

export function isUiSectionEnabled(config = {}, key) {
  return normalizeUiSections(config)[key] !== false;
}
