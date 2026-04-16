const DEFAULT_INTERFACE_HIERARCHY = {
  mainTabs: ['project_configuration', 'project_data', 'inspection', 'report'],
  inspection: {
    leftColumn: 'part_summary',
    centerTabs: ['inspector', 'image_metadata'],
    rightColumn: 'annotations',
  },
};

function parseStringArray(rawValue) {
  const match = rawValue.match(/^\[(.*)\]$/);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replace(/^"|"$/g, ''))
    .filter(Boolean);
}

export function parseInterfaceHierarchyToml(tomlText) {
  if (typeof tomlText !== 'string' || !tomlText.trim()) {
    return DEFAULT_INTERFACE_HIERARCHY;
  }

  const parsed = {
    mainTabs: [...DEFAULT_INTERFACE_HIERARCHY.mainTabs],
    inspection: {
      ...DEFAULT_INTERFACE_HIERARCHY.inspection,
      centerTabs: [...DEFAULT_INTERFACE_HIERARCHY.inspection.centerTabs],
    },
  };

  let currentSection = '';
  tomlText.split('\n').forEach((lineRaw) => {
    const line = lineRaw.trim();
    if (!line || line.startsWith('#')) return;

    const sectionMatch = line.match(/^\[(.+)]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      return;
    }

    const keyValue = line.match(/^([a-zA-Z0-9_]+)\s*=\s*(.+)$/);
    if (!keyValue) return;

    const [, key, value] = keyValue;
    if (currentSection === '' && key === 'main_tabs') {
      const parsedTabs = parseStringArray(value);
      if (parsedTabs.length > 0) parsed.mainTabs = parsedTabs;
      return;
    }

    if (currentSection === 'inspection_layout') {
      if (key === 'left_column') {
        parsed.inspection.leftColumn = value.replace(/^"|"$/g, '').trim() || parsed.inspection.leftColumn;
      } else if (key === 'center_tabs') {
        const centerTabs = parseStringArray(value);
        if (centerTabs.length > 0) parsed.inspection.centerTabs = centerTabs;
      } else if (key === 'right_column') {
        parsed.inspection.rightColumn = value.replace(/^"|"$/g, '').trim() || parsed.inspection.rightColumn;
      }
    }
  });

  return parsed;
}

export async function loadInterfaceHierarchy() {
  try {
    const response = await fetch('/interface-hierarchy.toml', { cache: 'no-store' });
    if (!response.ok) {
      return DEFAULT_INTERFACE_HIERARCHY;
    }
    const tomlText = await response.text();
    return parseInterfaceHierarchyToml(tomlText);
  } catch (_error) {
    return DEFAULT_INTERFACE_HIERARCHY;
  }
}

export { DEFAULT_INTERFACE_HIERARCHY };
