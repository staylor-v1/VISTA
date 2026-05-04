const fs = require('fs');
const path = require('path');

const appCss = fs.readFileSync(path.join(__dirname, '../../App.css'), 'utf8');

function cssRuleBody(selector) {
  const selectorIndex = appCss.indexOf(selector);
  expect(selectorIndex).toBeGreaterThanOrEqual(0);
  const bodyStart = appCss.indexOf('{', selectorIndex);
  const bodyEnd = appCss.indexOf('}', bodyStart);
  expect(bodyStart).toBeGreaterThan(selectorIndex);
  expect(bodyEnd).toBeGreaterThan(bodyStart);
  return appCss.slice(bodyStart + 1, bodyEnd);
}

describe('full-height workbench layout CSS contracts', () => {
  test('Analyze active tab keeps a viewport-backed graph height instead of collapsing', () => {
    expect(appCss).toMatch(
      /\.project-main-tab-shell\[data-active-main-tab="analyze"\][\s\S]*?min-height:\s*calc\(100vh - 180px\);/,
    );
    expect(appCss).toMatch(
      /\.project-main-panel\[data-active-main-tab="analyze"\][\s\S]*?min-height:\s*calc\(100vh - 180px\);/,
    );

    const graphBody = cssRuleBody('.project-main-panel[data-active-main-tab="analyze"] .analyze-graph');
    expect(graphBody).toMatch(/flex:\s*1;/);
    expect(graphBody).toMatch(/min-height:\s*max\(540px,\s*calc\(100vh - 340px\)\);/);
    expect(graphBody).not.toMatch(/min-height:\s*0\b/);
  });

  test('Inspection active tab keeps FlexLayout at a viewport-backed height instead of auto height', () => {
    expect(appCss).toMatch(
      /\.project-main-panel\[data-active-main-tab="inspection"\][\s\S]*?min-height:\s*calc\(100vh - 180px\);/,
    );

    const flexLayoutBody = cssRuleBody('.project-main-panel[data-active-main-tab="inspection"] .workbench-flexlayout-shell');
    expect(flexLayoutBody).toMatch(/flex:\s*1 1 auto;/);
    expect(flexLayoutBody).toMatch(
      /height:\s*max\(var\(--inspection-layout-min-height,\s*620px\),\s*calc\(100vh - 330px\)\);/,
    );
    expect(flexLayoutBody).toMatch(
      /min-height:\s*max\(var\(--inspection-layout-min-height,\s*620px\),\s*calc\(100vh - 330px\)\);/,
    );
    expect(flexLayoutBody).not.toMatch(/height:\s*auto\b/);
    expect(flexLayoutBody).not.toMatch(/min-height:\s*0\b/);
  });
});
